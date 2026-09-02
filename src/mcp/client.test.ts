import { describe, it, expect, vi, beforeEach } from 'vitest'
import { connectMCPServer, TimeoutError, createMCPToolDefinition, resolveTransportKind, sanitizeLogField, stableErrorType, normalizeCaughtError } from './client.js'
import type { McpServerConfig } from '../types.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

// Note: compile-time type-level contracts for the dual-selector (`type` /
// `transport`) PR live in `src/mcp/type-contracts.ts` so tsc actually checks
// them — test files are excluded from tsc via tsconfig.json's exclude list.

let mockClient: any
let attempt = 0

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(function () {
    return mockClient
  }),
}))

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn(),
}))

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: vi.fn(),
}))

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn(),
}))

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new DOMException('Aborted', 'AbortError'))
      },
      { once: true },
    )
  })
}

function createMockClient(overrides?: {
  connectDelay?: number
  listToolsDelay?: number
  tools?: any[]
  connectShouldReject?: boolean | ((attempt: number) => boolean)
  connectRejectError?: Error
  connectThrowValue?: unknown
  listToolsShouldReject?: boolean
}) {
  const {
    connectDelay = 0,
    listToolsDelay = 0,
    tools = [],
    connectShouldReject = false,
    connectRejectError,
    connectThrowValue,
    listToolsShouldReject = false,
  } = overrides || {}

  return {
    connect: vi.fn(async (_transport: any, options?: { signal?: AbortSignal; timeout?: number }) => {
      attempt++
      if (connectThrowValue !== undefined) {
        throw connectThrowValue   // as-is: ANY value (e.g. a revoked Proxy), review R2
      }
      const shouldReject = typeof connectShouldReject === 'function'
        ? connectShouldReject(attempt)
        : connectShouldReject
      if (shouldReject) {
        throw connectRejectError ?? new Error('connect failed')
      }
      await delay(connectDelay, options?.signal)
    }),
    listTools: vi.fn(async (_params?: any, options?: { signal?: AbortSignal; timeout?: number }) => {
      if (listToolsShouldReject) {
        throw new Error('listTools failed')
      }
      await delay(listToolsDelay, options?.signal)
      return { tools }
    }),
    close: vi.fn(),
  }
}

describe('connectMCPServer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    attempt = 0
  })

  it('returns connected status and tools on success', async () => {
    mockClient = createMockClient({ tools: [{ name: 'tool1', description: 'd', inputSchema: {} }] })

    const result = await connectMCPServer('test', { type: 'stdio', command: 'echo', retryPolicy: { timeoutMs: 1000, maxRetries: 0 } })

    expect(result.status).toBe('connected')
    expect(result.tools).toHaveLength(1)
    expect(result.tools[0].name).toBe('mcp__test__tool1')
    expect(result.error).toBeUndefined()
  })

  it('returns error when connect exceeds timeout', async () => {
    mockClient = createMockClient({ connectDelay: 1000 })

    const result = await connectMCPServer('test', { type: 'stdio', command: 'echo', retryPolicy: { timeoutMs: 50, maxRetries: 0 } })

    expect(result.status).toBe('error')
    expect(result.tools).toEqual([])
    expect(result.error).toBeInstanceOf(TimeoutError)
    expect((result.error as Error).message).toContain('timed out after 50ms')
  })

  it('returns error when listTools exceeds timeout', async () => {
    mockClient = createMockClient({ listToolsDelay: 1000 })

    const result = await connectMCPServer('test', { type: 'stdio', command: 'echo', retryPolicy: { timeoutMs: 50, maxRetries: 0 } })

    expect(result.status).toBe('error')
    expect(result.error).toBeInstanceOf(TimeoutError)
  })

  it('retries on failure up to maxRetries and succeeds', async () => {
    mockClient = createMockClient({
      connectShouldReject: (a) => a === 1,
      tools: [{ name: 'tool1', inputSchema: {} }],
    })

    const result = await connectMCPServer('test', { type: 'stdio', command: 'echo', retryPolicy: { timeoutMs: 1000, maxRetries: 1 } })

    expect(attempt).toBe(2)
    expect(result.status).toBe('connected')
    expect(result.tools).toHaveLength(1)
  })

  it('returns error after exhausting retries', async () => {
    mockClient = createMockClient({ connectShouldReject: true })

    const result = await connectMCPServer('test', { type: 'stdio', command: 'echo', retryPolicy: { timeoutMs: 1000, maxRetries: 2 } })

    expect(result.status).toBe('error')
    expect((result.error as Error).message).toBe('connect failed')
  })

  it('uses defaults when no retryPolicy is provided', async () => {
    mockClient = createMockClient({ connectDelay: 50, tools: [{ name: 'tool1', inputSchema: {} }] })

    const result = await connectMCPServer('test', { type: 'stdio', command: 'echo' })

    expect(result.status).toBe('connected')
    expect(mockClient.connect).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ timeout: 5000 }),
    )
  })
})

describe('createMCPToolDefinition', () => {
  it('defaults to deferred: true when no options provided', () => {
    const tool = createMCPToolDefinition('srv', { name: 't1', description: 'd' }, {} as any)
    expect(tool.deferred).toBe(true)
  })

  it('respects options.deferred: false', () => {
    const tool = createMCPToolDefinition('srv', { name: 't1', description: 'd' }, {} as any, { deferred: false })
    expect(tool.deferred).toBe(false)
  })

  it('auto-generates shortDescription from description', () => {
    const tool = createMCPToolDefinition('srv', { name: 't1', description: 'List all cron jobs' }, {} as any)
    expect(tool.shortDescription).toBe('List all cron jobs')
  })

  it('truncates long descriptions with ...(more) marker', () => {
    const long = 'X'.repeat(250)
    const tool = createMCPToolDefinition('srv', { name: 't1', description: long }, {} as any)
    expect(tool.shortDescription).toBe('X'.repeat(200) + '...(more)')
  })

  it('uses fallback description when mcpTool.description is absent', () => {
    const tool = createMCPToolDefinition('srv', { name: 't1' }, {} as any)
    // createMCPToolDefinition's existing fallback is 'MCP tool: <name> from <server>'
    expect(tool.shortDescription).toContain('t1')
    expect(tool.shortDescription).toContain('srv')
  })

  it('maps annotations.readOnlyHint=true to isReadOnly (issue #72)', () => {
    const tool = createMCPToolDefinition(
      'srv',
      { name: 'peek', annotations: { readOnlyHint: true } } as any,
      {} as any,
    )
    expect(tool.isReadOnly?.()).toBe(true)
  })

  it('defaults isReadOnly to false without readOnlyHint (issue #72)', () => {
    const write = createMCPToolDefinition(
      'srv',
      { name: 'mutate', annotations: { readOnlyHint: false } } as any,
      {} as any,
    )
    expect(write.isReadOnly?.()).toBe(false)
    const plain = createMCPToolDefinition('srv', { name: 'plain' } as any, {} as any)
    expect(plain.isReadOnly?.()).toBe(false)
  })

  it('preserves the full description in tool.description (no truncation)', () => {
    const long = 'Y'.repeat(500)
    const tool = createMCPToolDefinition('srv', { name: 't1', description: long }, {} as any)
    expect(tool.description).toBe(long)  // full description preserved
    expect(tool.shortDescription).toBe('Y'.repeat(200) + '...(more)')  // catalog摘要 truncated
  })
})

describe('resolveTransportKind (issue #14: MCP transport aliases)', () => {
  it("maps 'streamable_http' to the Streamable HTTP transport", () => {
    expect(resolveTransportKind({ type: 'streamable_http', url: 'https://x' })).toBe('streamable-http')
  })

  it("maps 'streamable-http' (kebab-case) to the Streamable HTTP transport", () => {
    expect(resolveTransportKind({ type: 'streamable-http', url: 'https://x' })).toBe('streamable-http')
  })

  it("maps the legacy 'http' alias to the Streamable HTTP transport", () => {
    expect(resolveTransportKind({ type: 'http', url: 'https://x' })).toBe('streamable-http')
  })

  it("maps 'stdio' to the stdio transport", () => {
    expect(resolveTransportKind({ type: 'stdio', command: 'echo' })).toBe('stdio')
  })

  it("maps 'sse' to the legacy SSE transport", () => {
    expect(resolveTransportKind({ type: 'sse', url: 'https://x' })).toBe('sse')
  })

  it('infers stdio when type is omitted but command is present', () => {
    const config: McpServerConfig = { command: 'echo', args: [] }
    expect(resolveTransportKind(config)).toBe('stdio')
  })

  it('infers Streamable HTTP when type is omitted but url is present', () => {
    const config: McpServerConfig = { url: 'https://x' }
    expect(resolveTransportKind(config)).toBe('streamable-http')
  })

  it('prefers an explicit stdio type even when url is also present (explicit wins over inference)', () => {
    // explicit type always wins; this guards against ambiguous configs
    expect(resolveTransportKind({ type: 'stdio', command: 'echo', url: 'https://x' } as any)).toBe('stdio')
  })

  it('throws a clear error for an unknown explicit transport type', () => {
    expect(() => resolveTransportKind({ type: 'websocket', url: 'wss://x' } as any)).toThrow(
      /Unsupported MCP transport type: websocket/,
    )
  })

  it('throws a helpful error mentioning supported aliases', () => {
    try {
      resolveTransportKind({ type: 'ws', url: 'wss://x' } as any)
      throw new Error('should have thrown')
    } catch (err: any) {
      expect(err.message).toContain('streamable_http')
      expect(err.message).toContain('streamable-http')
      expect(err.message).toContain('http')
      expect(err.message).toContain('stdio')
      expect(err.message).toContain('sse')
    }
  })

  it('throws when type is omitted and neither command nor url is present', () => {
    expect(() => resolveTransportKind({} as any)).toThrow(/Cannot infer MCP transport/)
  })

  // --- issue #14 follow-up: `transport` alternate selector field ---

  it("accepts 'transport' field as an alias for 'type' (streamable_http)", () => {
    const config: McpServerConfig = { transport: 'streamable_http', url: 'https://x' }
    expect(resolveTransportKind(config)).toBe('streamable-http')
  })

  it("accepts 'transport' field with the kebab-case alias", () => {
    const config: McpServerConfig = { transport: 'streamable-http', url: 'https://x' }
    expect(resolveTransportKind(config)).toBe('streamable-http')
  })

  it("accepts 'transport' field with the legacy http alias", () => {
    const config: McpServerConfig = { transport: 'http', url: 'https://x' }
    expect(resolveTransportKind(config)).toBe('streamable-http')
  })

  it("accepts 'transport: stdio'", () => {
    const config: McpServerConfig = { transport: 'stdio', command: 'echo' }
    expect(resolveTransportKind(config)).toBe('stdio')
  })

  it("accepts 'transport: sse'", () => {
    const config: McpServerConfig = { transport: 'sse', url: 'https://x' }
    expect(resolveTransportKind(config)).toBe('sse')
  })

  it('accepts both type and transport when they normalize to the same kind', () => {
    // different spellings, same underlying transport → ok
    const a: McpServerConfig = { type: 'http', transport: 'streamable-http', url: 'https://x' }
    const b: McpServerConfig = { type: 'streamable_http', transport: 'http', url: 'https://x' }
    expect(resolveTransportKind(a)).toBe('streamable-http')
    expect(resolveTransportKind(b)).toBe('streamable-http')
  })

  it('throws a conflict error when type and transport resolve to different kinds', () => {
    expect(() =>
      resolveTransportKind({ type: 'stdio', transport: 'http', command: 'echo', url: 'https://x' } as any),
    ).toThrow(/MCP transport conflict/)
  })

  it('includes both field values in the conflict error message', () => {
    try {
      resolveTransportKind({ type: 'sse', transport: 'stdio', url: 'https://x', command: 'echo' } as any)
      throw new Error('should have thrown')
    } catch (err: any) {
      expect(err.message).toContain('type=sse')
      expect(err.message).toContain('transport=stdio')
    }
  })

  it('throws on unknown value in the transport field', () => {
    expect(() => resolveTransportKind({ transport: 'ws', url: 'wss://x' } as any)).toThrow(
      /Unsupported MCP transport: ws/,
    )
  })
})

describe('createTransport alias wiring (issue #14)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    attempt = 0
  })

  it('instantiates StreamableHTTPClientTransport for type: streamable_http', async () => {
    mockClient = createMockClient({ tools: [] })
    vi.mocked(StreamableHTTPClientTransport).mockClear()
    await connectMCPServer('srv', { type: 'streamable_http', url: 'https://x', retryPolicy: { timeoutMs: 1000, maxRetries: 0 } })
    expect(StreamableHTTPClientTransport).toHaveBeenCalledTimes(1)
  })

  it('instantiates StreamableHTTPClientTransport for type: streamable-http', async () => {
    mockClient = createMockClient({ tools: [] })
    vi.mocked(StreamableHTTPClientTransport).mockClear()
    await connectMCPServer('srv', { type: 'streamable-http', url: 'https://x', retryPolicy: { timeoutMs: 1000, maxRetries: 0 } })
    expect(StreamableHTTPClientTransport).toHaveBeenCalledTimes(1)
  })

  it('instantiates StreamableHTTPClientTransport for the legacy http alias', async () => {
    mockClient = createMockClient({ tools: [] })
    vi.mocked(StreamableHTTPClientTransport).mockClear()
    await connectMCPServer('srv', { type: 'http', url: 'https://x', retryPolicy: { timeoutMs: 1000, maxRetries: 0 } })
    expect(StreamableHTTPClientTransport).toHaveBeenCalledTimes(1)
  })

  it('infers Streamable HTTP from url when type is omitted', async () => {
    mockClient = createMockClient({ tools: [] })
    vi.mocked(StreamableHTTPClientTransport).mockClear()
    await connectMCPServer('srv', { url: 'https://x', retryPolicy: { timeoutMs: 1000, maxRetries: 0 } } as any)
    expect(StreamableHTTPClientTransport).toHaveBeenCalledTimes(1)
  })

  it('infers stdio from command when type is omitted', async () => {
    mockClient = createMockClient({ tools: [] })
    vi.mocked(StdioClientTransport).mockClear()
    await connectMCPServer('srv', { command: 'echo', retryPolicy: { timeoutMs: 1000, maxRetries: 0 } } as any)
    expect(StdioClientTransport).toHaveBeenCalledTimes(1)
  })

  it('instantiates SSEClientTransport for type: sse (unchanged)', async () => {
    mockClient = createMockClient({ tools: [] })
    vi.mocked(SSEClientTransport).mockClear()
    await connectMCPServer('srv', { type: 'sse', url: 'https://x', retryPolicy: { timeoutMs: 1000, maxRetries: 0 } })
    expect(SSEClientTransport).toHaveBeenCalledTimes(1)
  })

  it('returns error status (does not throw) for an unsupported explicit type', async () => {
    mockClient = createMockClient({ tools: [] })
    const result = await connectMCPServer('srv', { type: 'ws', url: 'wss://x', retryPolicy: { timeoutMs: 1000, maxRetries: 0 } } as any)
    expect(result.status).toBe('error')
    expect((result.error as Error).message).toMatch(/Unsupported MCP transport type: ws/)
  })
})

describe('stdio cwd wiring (issue #14 follow-up: working-directory base)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    attempt = 0
  })

  it('forwards config.cwd to StdioClientTransport', async () => {
    mockClient = createMockClient({ tools: [] })
    vi.mocked(StdioClientTransport).mockClear()
    await connectMCPServer('srv', {
      type: 'stdio',
      command: 'echo',
      cwd: '/explicit/cwd',
      retryPolicy: { timeoutMs: 1000, maxRetries: 0 },
    })
    expect(StdioClientTransport).toHaveBeenCalledTimes(1)
    const passed = (StdioClientTransport as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(passed.cwd).toBe('/explicit/cwd')
    expect(passed.command).toBe('echo')
  })

  it('omits cwd from StdioServerParameters when not set (lets MCP SDK use its default)', async () => {
    mockClient = createMockClient({ tools: [] })
    vi.mocked(StdioClientTransport).mockClear()
    await connectMCPServer('srv', {
      type: 'stdio',
      command: 'echo',
      retryPolicy: { timeoutMs: 1000, maxRetries: 0 },
    })
    const passed = (StdioClientTransport as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(passed).not.toHaveProperty('cwd')
  })

  it('does not pass cwd for non-stdio transports', async () => {
    mockClient = createMockClient({ tools: [] })
    vi.mocked(StreamableHTTPClientTransport).mockClear()
    // cwd is meaningless for HTTP; even if user supplies it, we don't pass it
    // (the StreamableHTTPClientTransport constructor would reject unknown fields).
    await connectMCPServer('srv', {
      type: 'streamable_http',
      url: 'https://x',
      cwd: '/should/be/ignored',
      retryPolicy: { timeoutMs: 1000, maxRetries: 0 },
    } as any)
    expect(StreamableHTTPClientTransport).toHaveBeenCalledTimes(1)
    // constructor should be called with URL + requestInit only; no cwd leaks
    const args = (StreamableHTTPClientTransport as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(args[0]).toBeInstanceOf(URL)
  })
})

describe('sanitizeLogField (issue #77)', () => {
  it('wraps plain ASCII in quotes unchanged', () => {
    expect(sanitizeLogField('my-server')).toBe('"my-server"')
  })

  it('escapes newlines and control characters to a single line', () => {
    const out = sanitizeLogField('evil\nserver\u0007')
    expect(out).toBe('"evil\\nserver\\u0007"')
    expect(out).not.toMatch(/[\n\u0000-\u001f]/)
  })

  it('truncates over-length values with ellipsis, keeping the closing quote', () => {
    const out = sanitizeLogField('x'.repeat(300), 128)
    expect(out.length).toBe(128)
    expect(out.endsWith('…"')).toBe(true)
  })

  it('passes values whose quoted length equals maxLength', () => {
    const name = 'a'.repeat(126)
    expect(sanitizeLogField(name, 128)).toBe('"' + name + '"')
  })

  it('escapes C1 controls and Unicode line/paragraph separators (issue #81)', () => {
    // JSON.stringify leaves U+0080–U+009F and U+2028/U+2029 raw — these render
    // as line breaks, so the single-line contract requires explicit escaping.
    const out = sanitizeLogField('a\u0085b\u2028c\u2029d\u0090e')
    expect(out).toBe('"a\\u0085b\\u2028c\\u2029d\\u0090e"')
    expect(out).not.toMatch(/[\u0080-\u009f\u2028\u2029]/)
  })
})

describe('connectMCPServer failure log sanitization (issue #77)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    attempt = 0
  })

  it('final failure log omits raw error message and credentials; returned error intact', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const thrown = new Error('ETIMEDOUT https://user:sekret-token@db.internal:5432/path')
      mockClient = createMockClient({ connectShouldReject: true, connectRejectError: thrown })

      const result = await connectMCPServer('prod-db', {
        type: 'stdio', command: 'echo',
        retryPolicy: { timeoutMs: 100, maxRetries: 0 },
      })

      // Return-value contract unchanged: error status + the SAME Error instance
      // (the full underlying error stays the host's to handle/sanitize).
      expect(result.status).toBe('error')
      expect(result.error).toBe(thrown)

      // Log contract: static message + structured fields, no underlying text.
      expect(errSpy).toHaveBeenCalledTimes(1)
      const [msg, fields] = errSpy.mock.calls[0]
      expect(msg).toBe('[MCP] Failed to connect to server')
      const logged = JSON.stringify(errSpy.mock.calls[0])
      expect(logged).not.toContain('sekret-token')
      expect(logged).not.toContain('https://user')
      expect(logged).not.toContain('ETIMEDOUT')
      expect(fields.errorType).toBe('Error')
      expect(fields.server).toBe('"prod-db"')
    } finally {
      errSpy.mockRestore()
    }
  })

  it('retry warnings carry no error text or credentials; attempt counters sanitized', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      mockClient = createMockClient({
        connectShouldReject: true,
        connectRejectError: new Error('GET https://user:tok9@host/v1 failed'),
      })
      await connectMCPServer('srv', {
        type: 'stdio', command: 'echo',
        retryPolicy: { timeoutMs: 100, maxRetries: 2 },
      })

      expect(warnSpy).toHaveBeenCalledTimes(2)
      for (const call of warnSpy.mock.calls) {
        const logged = JSON.stringify(call)
        expect(logged).not.toContain('tok9')
        expect(logged).not.toContain('https://user')
      }
      const [msg, fields] = warnSpy.mock.calls[0]
      expect(msg).toBe('[MCP] Retrying connection')
      expect(fields).toMatchObject({ server: '"srv"', attempt: 2, maxAttempts: 3 })
      // The final failure log is equally clean
      expect(JSON.stringify(errSpy.mock.calls[0])).not.toContain('tok9')
    } finally {
      warnSpy.mockRestore()
      errSpy.mockRestore()
    }
  })

  it('server name with newline/control chars cannot inject log lines', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      mockClient = createMockClient({ connectShouldReject: true })
      await connectMCPServer('evil\nserver\u0007', {
        type: 'stdio', command: 'echo',
        retryPolicy: { timeoutMs: 100, maxRetries: 0 },
      })
      const fields = errSpy.mock.calls[0][1]
      expect(fields.server).toBe('"evil\\nserver\\u0007"')
      // No raw control characters anywhere in the logged fields
      const flat = JSON.stringify(errSpy.mock.calls[0])
      expect(flat).not.toMatch(/[\n\u0000-\u0008\u000b\u000c\u000e-\u001f]/)
    } finally {
      errSpy.mockRestore()
    }
  })

  it('mutated Error.name cannot leak credentials into errorType (issue #81)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const thrown = new Error('connect refused')
      thrown.name = 'https://user:tok81@host/api'
      mockClient = createMockClient({ connectShouldReject: true, connectRejectError: thrown })

      const result = await connectMCPServer('srv', {
        type: 'stdio', command: 'echo',
        retryPolicy: { timeoutMs: 100, maxRetries: 0 },
      })

      expect(result.status).toBe('error')
      const [msg, fields] = errSpy.mock.calls[0]
      expect(msg).toBe('[MCP] Failed to connect to server')
      expect(fields.errorType).toBe('Error')   // mutated name collapsed to a stable constant
      const logged = JSON.stringify(errSpy.mock.calls[0])
      expect(logged).not.toContain('tok81')
      expect(logged).not.toContain('https://user')
    } finally {
      errSpy.mockRestore()
    }
  })

  it('identifier-shaped credentials in Error.name cannot leak (review R1)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const thrown = new Error('connect refused')
      thrown.name = 'sk_live_SUPERSECRET_123'
      mockClient = createMockClient({ connectShouldReject: true, connectRejectError: thrown })

      const result = await connectMCPServer('srv', {
        type: 'stdio', command: 'echo',
        retryPolicy: { timeoutMs: 100, maxRetries: 0 },
      })

      expect(result.status).toBe('error')
      const fields = errSpy.mock.calls[0][1]
      expect(fields.errorType).toBe('Error')
      const logged = JSON.stringify(errSpy.mock.calls[0])
      expect(logged).not.toContain('sk_live')
      expect(logged).not.toContain('SUPERSECRET')
    } finally {
      errSpy.mockRestore()
    }
  })

  it('throwing name getter cannot break the error-connection return contract (review R1)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const thrown = new Error('connect refused')
      Object.defineProperty(thrown, 'name', { get() { throw new Error('getter boom') } })
      mockClient = createMockClient({ connectShouldReject: true, connectRejectError: thrown })

      const result = await connectMCPServer('srv', {
        type: 'stdio', command: 'echo',
        retryPolicy: { timeoutMs: 100, maxRetries: 0 },
      })

      // The function STILL returns the error connection with the original error
      expect(result.status).toBe('error')
      expect(result.error).toBe(thrown)
      // And the log still emitted with the stable fallback
      expect(errSpy).toHaveBeenCalledTimes(1)
      expect(errSpy.mock.calls[0][1].errorType).toBe('Error')
    } finally {
      errSpy.mockRestore()
    }
  })

  it('revoked Proxy thrown from connect cannot break the error-connection return contract (review R2)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { proxy, revoke } = Proxy.revocable({}, {})
      revoke()
      mockClient = createMockClient({ connectThrowValue: proxy })

      const result = await connectMCPServer('srv', {
        type: 'stdio', command: 'echo',
        retryPolicy: { timeoutMs: 100, maxRetries: 1 },
      })

      // Still returns an error connection — never rejects
      expect(result.status).toBe('error')
      expect(result.error).toBeInstanceOf(Error)
      expect((result.error as Error).message).toBe('connection attempt threw a non-stringifiable value')
      // Final failure log still emitted with the stable errorType
      expect(errSpy).toHaveBeenCalledTimes(1)
      expect(errSpy.mock.calls[0][1].errorType).toBe('Error')
    } finally {
      errSpy.mockRestore()
    }
  })
})

describe('normalizeCaughtError (issue #81, review R2)', () => {
  it('passes Error instances through unchanged', () => {
    const e = new Error('x')
    expect(normalizeCaughtError(e)).toBe(e)
  })

  it('wraps stringifiable non-Error thrown values', () => {
    expect(normalizeCaughtError('boom').message).toBe('boom')
    expect(normalizeCaughtError(42).message).toBe('42')
  })

  it('is total: revoked proxies collapse to an SDK-owned constant message', () => {
    const { proxy, revoke } = Proxy.revocable({}, {})
    revoke()
    const out = normalizeCaughtError(proxy)
    expect(out).toBeInstanceOf(Error)
    expect(out.message).toBe('connection attempt threw a non-stringifiable value')
  })
})

describe('stableErrorType (issue #81, review R1)', () => {
  it('maps SDK-known classes to SDK-owned constants; forged names are not trusted', () => {
    expect(stableErrorType(new Error('x'))).toBe('Error')
    const t = new Error('x')
    t.name = 'TimeoutError'   // forged name — only real instanceof wins
    expect(stableErrorType(t)).toBe('Error')
    expect(stableErrorType(new TimeoutError('t'))).toBe('TimeoutError')
  })

  it('cannot leak identifier-shaped credentials carried in Error.name', () => {
    const a = new Error('x')
    a.name = 'sk_live_SUPERSECRET_123'   // passes any identifier shape check
    expect(stableErrorType(a)).toBe('Error')
  })

  it('is total: throwing name getters and instanceof traps cannot break logging', () => {
    const g = new Error('x')
    Object.defineProperty(g, 'name', { get() { throw new Error('getter boom') } })
    expect(stableErrorType(g)).toBe('Error')
    const trap = new Proxy({}, { getPrototypeOf() { throw new Error('trap') } })
    expect(stableErrorType(trap)).toBe('Error')
  })

  it('uses typeof for non-Error values', () => {
    expect(stableErrorType('boom')).toBe('string')
    expect(stableErrorType(42)).toBe('number')
    expect(stableErrorType(undefined)).toBe('undefined')
  })
})

describe('connectMCPServer close semantics (issue #81)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    attempt = 0
  })

  it('successful connection close() closes the underlying client exactly once', async () => {
    mockClient = createMockClient({ tools: [{ name: 'tool1', description: 'd', inputSchema: {} }] })
    const result = await connectMCPServer('test', {
      type: 'stdio', command: 'echo',
      retryPolicy: { timeoutMs: 1000, maxRetries: 0 },
    })

    expect(result.status).toBe('connected')
    expect(mockClient.close).not.toHaveBeenCalled()
    await result.close()
    expect(mockClient.close).toHaveBeenCalledTimes(1)
  })

  it('error connection close() is a safe no-op', async () => {
    mockClient = createMockClient({ connectShouldReject: true })
    const result = await connectMCPServer('test', {
      type: 'stdio', command: 'echo',
      retryPolicy: { timeoutMs: 100, maxRetries: 0 },
    })

    expect(result.status).toBe('error')
    await expect(result.close()).resolves.toBeUndefined()
    expect(mockClient.close).not.toHaveBeenCalled()
  })
})

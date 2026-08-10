import { describe, it, expect, vi, beforeEach } from 'vitest'
import { connectMCPServer, TimeoutError, createMCPToolDefinition, resolveTransportKind } from './client.js'
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
  listToolsShouldReject?: boolean
}) {
  const {
    connectDelay = 0,
    listToolsDelay = 0,
    tools = [],
    connectShouldReject = false,
    listToolsShouldReject = false,
  } = overrides || {}

  return {
    connect: vi.fn(async (_transport: any, options?: { signal?: AbortSignal; timeout?: number }) => {
      attempt++
      const shouldReject = typeof connectShouldReject === 'function'
        ? connectShouldReject(attempt)
        : connectShouldReject
      if (shouldReject) {
        throw new Error('connect failed')
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

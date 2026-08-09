import { describe, it, expect, vi, beforeEach } from 'vitest'
import { connectMCPServer, TimeoutError, createMCPToolDefinition } from './client.js'

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

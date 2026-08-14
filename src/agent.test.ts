import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { z } from 'zod'
import { Agent } from './agent.js'
import { createSdkMcpServer } from './sdk-mcp-server.js'
import { tool } from './tool-helper.js'
import type { AgentOptions, McpServerConfig } from './types.js'

// Mocked pool — only the acquireMCPConnection symbol is replaced; the rest
// of the module surface (types, internal helpers) stays intact.
vi.mock('./mcp/pool.js', async (importOriginal) => {
  const actual = await importOriginal() as any
  return {
    ...actual,
    acquireMCPConnection: vi.fn(actual.acquireMCPConnection),
  }
})

import { acquireMCPConnection } from './mcp/pool.js'

/**
 * Minimal AgentOptions to construct an agent without connecting real MCP
 * servers. We only test the in-process SDK server path so no subprocess is
 * spawned. persistSession:false avoids disk writes during tests.
 */
function makeBaseOptions(overrides: Partial<AgentOptions> = {}): AgentOptions {
  return {
    model: 'test-model',
    apiKey: 'fake',
    persistSession: false,
    // Disable SnapshotEngine: tests run in parallel and would otherwise all
    // `git init --bare` into the same shared ~/.agents/snapshot/<hash> dir,
    // racing on git's config lock (File exists). Not under test here.
    enableFileRevert: false,
    mcpServers: {},
    ...overrides,
  }
}

/**
 * Wait for the agent's async setup to complete and then read its private
 * `toolPool` via bracket notation (the field is private but accessible at
 * runtime). This is the smallest-footprint way to inspect the resolved
 * MCP tools without spinning up the full AgentEnvironment.
 */
async function getPoolTools(agent: Agent): Promise<any[]> {
  await (agent as any).setupDone
  return (agent as any).toolPool as any[]
}

/** Build a minimal SDK tool that returns 'hi'. */
function greetTool(opts: { deferred?: boolean } = {}) {
  return tool(
    'greet',
    'say hi',
    { name: z.string() },
    async () => ({ content: [{ type: 'text' as const, text: 'hi' }] }),
    opts.deferred !== undefined ? { deferred: opts.deferred } : undefined,
  )
}

describe('Agent MCP deferred resolution', () => {
  it('MCP tools default to deferred when eagerMcp is unset', async () => {
    const sdk = createSdkMcpServer({
      name: 'mylocal',
      tools: [greetTool()],
    })
    const agent = new Agent(makeBaseOptions({ mcpServers: { mylocal: sdk } }))

    const pool = await getPoolTools(agent)
    const mcpTool = pool.find((t) => t.name === 'mcp__mylocal__greet')
    expect(mcpTool).toBeDefined()
    expect(mcpTool.deferred).toBe(true)
  })

  it('eagerMcp: true reverts all MCP tools to eager', async () => {
    const sdk = createSdkMcpServer({
      name: 'mylocal',
      tools: [greetTool()],
    })
    const agent = new Agent(
      makeBaseOptions({
        mcpServers: { mylocal: sdk },
        eagerMcp: true,
      }),
    )

    const pool = await getPoolTools(agent)
    const mcpTool = pool.find((t) => t.name === 'mcp__mylocal__greet')
    expect(mcpTool).toBeDefined()
    expect(mcpTool.deferred).toBe(false)
  })

  it('per-server deferred: false overrides global default', async () => {
    const sdk = createSdkMcpServer({
      name: 'mylocal',
      tools: [greetTool()],
      deferred: false, // server-level opt-out
    })
    const agent = new Agent(makeBaseOptions({ mcpServers: { mylocal: sdk } }))

    const pool = await getPoolTools(agent)
    const mcpTool = pool.find((t) => t.name === 'mcp__mylocal__greet')
    expect(mcpTool).toBeDefined()
    expect(mcpTool.deferred).toBe(false)
  })

  it('tool-level explicit deferred wins over server-level (OR-relation)', async () => {
    const sdk = createSdkMcpServer({
      name: 'mylocal',
      tools: [greetTool({ deferred: true })], // tool says deferred
      deferred: false, // server says eager — tool wins
    })
    const agent = new Agent(makeBaseOptions({ mcpServers: { mylocal: sdk } }))

    const pool = await getPoolTools(agent)
    const mcpTool = pool.find((t) => t.name === 'mcp__mylocal__greet')
    expect(mcpTool).toBeDefined()
    expect(mcpTool.deferred).toBe(true)
  })

  it('eagerMcp: true does not override an explicit per-server deferred: true', async () => {
    // Decision table row: eagerMcp=true, server.deferred=true → true
    const sdk = createSdkMcpServer({
      name: 'mylocal',
      tools: [greetTool()],
      deferred: true, // explicit opt-in survives global eager
    })
    const agent = new Agent(
      makeBaseOptions({
        mcpServers: { mylocal: sdk },
        eagerMcp: true,
      }),
    )

    const pool = await getPoolTools(agent)
    const mcpTool = pool.find((t) => t.name === 'mcp__mylocal__greet')
    expect(mcpTool).toBeDefined()
    expect(mcpTool.deferred).toBe(true)
  })

  it('tool-level explicit deferred:false wins over server default even when server is unset', async () => {
    // OR-relation: tool.deferred:false + server.deferred:undefined (global default true)
    // → tool wins → eager
    const sdk = createSdkMcpServer({
      name: 'mylocal',
      tools: [greetTool({ deferred: false })],
    })
    const agent = new Agent(makeBaseOptions({ mcpServers: { mylocal: sdk } }))

    const pool = await getPoolTools(agent)
    const mcpTool = pool.find((t) => t.name === 'mcp__mylocal__greet')
    expect(mcpTool).toBeDefined()
    expect(mcpTool.deferred).toBe(false)
  })
})

describe('Agent MCP stdio cwd resolution (issue #14 follow-up)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('injects AgentOptions.cwd into stdio config when cwd is unset', async () => {
    const stdioConfig: McpServerConfig = { type: 'stdio', command: 'echo' }
    const agent = new Agent(makeBaseOptions({
      cwd: '/agent/workspace',
      mcpServers: { srv: stdioConfig },
    }))

    // Drive async setup; the agent calls acquireMCPConnection internally.
    // The connection will fail because the mocked pool falls through to the
    // real acquireMCPConnection (which would try to spawn 'echo'); that's
    // fine — we only care about the config passed in.
    await getPoolTools(agent).catch(() => {})

    const passedConfig = vi.mocked(acquireMCPConnection).mock.calls[0]?.[1] as McpServerConfig | undefined
    expect(passedConfig).toBeDefined()
    expect(passedConfig!.type).toBe('stdio')
    expect((passedConfig as any).cwd).toBe('/agent/workspace')
  })

  it('preserves explicit server-level cwd over AgentOptions.cwd', async () => {
    const stdioConfig: McpServerConfig = {
      type: 'stdio',
      command: 'echo',
      cwd: '/explicit/server/cwd',
    } as any
    const agent = new Agent(makeBaseOptions({
      cwd: '/agent/workspace',
      mcpServers: { srv: stdioConfig },
    }))

    await getPoolTools(agent).catch(() => {})

    const passedConfig = vi.mocked(acquireMCPConnection).mock.calls[0]?.[1] as McpServerConfig | undefined
    expect((passedConfig as any).cwd).toBe('/explicit/server/cwd')
  })

  it('does not inject cwd when AgentOptions.cwd is unset', async () => {
    const stdioConfig: McpServerConfig = { type: 'stdio', command: 'echo' }
    const agent = new Agent(makeBaseOptions({
      // no cwd
      mcpServers: { srv: stdioConfig },
    }))

    await getPoolTools(agent).catch(() => {})

    const passedConfig = vi.mocked(acquireMCPConnection).mock.calls[0]?.[1] as McpServerConfig | undefined
    expect(passedConfig).toBeDefined()
    // cwd should NOT be set — MCP SDK uses its process.cwd() default
    expect((passedConfig as any).cwd).toBeUndefined()
  })

  it('does not inject cwd for http transports', async () => {
    const httpConfig: McpServerConfig = { type: 'streamable_http', url: 'https://x' }
    const agent = new Agent(makeBaseOptions({
      cwd: '/agent/workspace',
      mcpServers: { srv: httpConfig },
    }))

    await getPoolTools(agent).catch(() => {})

    const passedConfig = vi.mocked(acquireMCPConnection).mock.calls[0]?.[1] as McpServerConfig | undefined
    expect(passedConfig).toBeDefined()
    expect(passedConfig!.type).toBe('streamable_http')
    expect((passedConfig as any).cwd).toBeUndefined()
  })
})

describe('Agent.prompt() error propagation (issue #28)', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  /**
   * Drive a prompt() promise to completion under fake timers: advance the
   * clock in small steps so chained backoff sleeps + microtask flushes
   * interleave correctly (one big advance does not reliably settle the
   * async-generator chain).
   */
  async function settleWithFakeTimers<T>(p: Promise<T>): Promise<T> {
    let settled = false
    void p.then(() => (settled = true), () => (settled = true))
    for (let i = 0; i < 600 && !settled; i++) {
      await vi.advanceTimersByTimeAsync(1_000)
    }
    return p
  }

  it('surfaces a provider 429 as is_error with error_type preserved (never success-looking)', async () => {
    vi.useFakeTimers()
    const agent = new Agent(makeBaseOptions())
    const err = Object.assign(new Error('429 Too Many Requests: rate limited'), { status: 429 })
    // Non-streaming default path: engine calls createMessage via withRetry.
    // 429 is NOT retryable (fails fast, no backoff); fake timers are a no-op here.
    ;(agent as any).provider = {
      apiType: 'anthropic-messages',
      createMessage: vi.fn(async () => { throw err }),
      createMessageStream: async function* () { throw err },
    }

    const result = await settleWithFakeTimers(agent.prompt('hello'))

    expect(result.is_error).toBe(true)
    expect(result.error_type).toBe('rate_limit')
    expect(result.errors?.join(' ')).toContain('429')
    expect(result.text).toBe('') // no assistant text was ever produced
  })

  it('surfaces a non-retryable provider failure (auth) without retries', async () => {
    // Real timers: auth errors are not retried, so no backoff to skip.
    const agent = new Agent(makeBaseOptions())
    const err = Object.assign(new Error('401 Unauthorized: invalid api key'), { status: 401 })
    const createMessage = vi.fn(async () => { throw err })
    ;(agent as any).provider = {
      apiType: 'anthropic-messages',
      createMessage,
      createMessageStream: async function* () { throw err },
    }

    const result = await agent.prompt('hello')

    expect(result.is_error).toBe(true)
    expect(result.error_type).toBe('auth')
    expect(result.errors?.join(' ')).toContain('401')
    expect(createMessage).toHaveBeenCalledTimes(1) // no retries for auth
  })

  it('surfaces a UserPromptSubmit hook block as an error result', async () => {
    const createMessage = vi.fn()
    const agent = new Agent(makeBaseOptions({
      hooks: {
        UserPromptSubmit: [{ hooks: [async () => ({ block: true })] }],
      },
    }))
    ;(agent as any).provider = {
      apiType: 'anthropic-messages',
      createMessage,
      createMessageStream: async function* () { throw new Error('should not be called') },
    }

    const result = await agent.prompt('hello')

    expect(result.is_error).toBe(true)
    expect(result.error_type).toBe('error_during_execution')
    expect(result.errors?.join(' ')).toContain('Blocked by UserPromptSubmit hook')
    expect(createMessage).not.toHaveBeenCalled() // provider never invoked
  })

  it('surfaces retryable overload errors after retries are exhausted', async () => {
    vi.useFakeTimers()
    const agent = new Agent(makeBaseOptions())
    const err = Object.assign(new Error('529 overloaded'), { status: 529 })
    const createMessage = vi.fn(async () => { throw err })
    ;(agent as any).provider = {
      apiType: 'anthropic-messages',
      createMessage,
      createMessageStream: async function* () { throw err },
    }

    const result = await settleWithFakeTimers(agent.prompt('hello'))

    expect(result.is_error).toBe(true)
    expect(result.error_type).toBe('overloaded')
    expect(createMessage.mock.calls.length).toBeGreaterThan(1) // retried before giving up
  })

  it('success case: no error fields attached (shape unchanged)', async () => {
    const agent = new Agent(makeBaseOptions())
    ;(agent as any).provider = {
      apiType: 'anthropic-messages',
      createMessage: vi.fn(async () => ({
        content: [{ type: 'text', text: 'final answer' }],
        usage: { input_tokens: 10, output_tokens: 5 },
        stop_reason: 'end_turn',
      })),
      createMessageStream: async function* () { /* not used */ },
    }

    const result = await agent.prompt('hello')

    expect(result.text).toBe('final answer')
    expect(result.is_error).toBeUndefined()
    expect(result.error_type).toBeUndefined()
    expect(result.errors).toBeUndefined()
  })
})

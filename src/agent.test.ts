import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { z } from 'zod'
import { Agent, query } from './agent.js'
import { createSdkMcpServer } from './sdk-mcp-server.js'
import { tool } from './tool-helper.js'
import type { AgentOptions, McpServerConfig, AgentInput, ContentBlockParam, SDKMessage } from './types.js'
import type { LLMProvider, CreateMessageParams, StreamChunk, NormalizedMessageParam } from './providers/types.js'
import type { HookInput } from './hooks.js'
import { loadSession, deleteSession } from './session.js'

// Mocked pool — only the acquireMCPConnection symbol is replaced; the rest
// of the module surface (types, internal helpers) stays intact.
vi.mock('./mcp/pool.js', async (importOriginal) => {
  const actual = await importOriginal() as any
  return {
    ...actual,
    acquireMCPConnection: vi.fn(actual.acquireMCPConnection),
  }
})

// Retry backoff clamped to ~1ms: withRetry's real exponential backoff
// (2s/4s/8s) makes retry-exhaustion tests either slow (14s of real waiting)
// or dependent on vi.useFakeTimers — and fake timers starve real I/O
// (child_process/undifi callbacks), which caused intermittent hangs when
// mixed with other tests' leftover sockets. With 1ms delays the retry chain
// completes in ~5ms under REAL timers: fast AND deterministic.
// No other test in this file relies on real backoff durations.
vi.mock('./utils/retry.js', async (importOriginal) => {
  const actual = await importOriginal() as any
  const fastConfig = (config: any) => ({
    ...actual.DEFAULT_RETRY_CONFIG, // base when caller passes undefined
    ...config,
    baseDelayMs: 1, // force fast backoff either way
    maxDelayMs: 1,
  })
  return {
    ...actual,
    withRetry: (fn: () => Promise<any>, config: any, signal?: AbortSignal) =>
      actual.withRetry(fn, fastConfig(config), signal),
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
    // Short retryPolicy so the real fetch to the unresolvable host fails fast
    // (200ms) instead of hanging for the default 5000ms MCP timeout — the
    // default races against vitest's 5s test timeout and flakes depending on
    // how quickly the network rejects the connection.
    const httpConfig: McpServerConfig = {
      type: 'streamable_http',
      url: 'https://x',
      retryPolicy: { timeoutMs: 200, maxRetries: 0 },
    }
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
    vi.restoreAllMocks()
  })

  it('surfaces a provider 429 as is_error with error_type preserved (never success-looking)', async () => {
    const agent = new Agent(makeBaseOptions())
    const err = Object.assign(new Error('429 Too Many Requests: rate limited'), { status: 429 })
    // Non-streaming default path: engine calls createMessage via withRetry.
    // 429 is NOT retryable (fails fast, no backoff) — real timers suffice.
    ;(agent as any).provider = {
      apiType: 'anthropic-messages',
      createMessage: vi.fn(async () => { throw err }),
      createMessageStream: async function* () { throw err },
    }

    const result = await agent.prompt('hello')

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
    // 529 is retryable: withRetry runs the full chain (initial + 3 retries).
    // The file-level retry mock clamps backoff to 1ms, so the chain completes
    // in ~5ms under real timers — no fake timers needed (see mock comment).
    const agent = new Agent(makeBaseOptions())
    const err = Object.assign(new Error('529 overloaded'), { status: 529 })
    const createMessage = vi.fn(async () => { throw err })
    ;(agent as any).provider = {
      apiType: 'anthropic-messages',
      createMessage,
      createMessageStream: async function* () { throw err },
    }

    const result = await agent.prompt('hello')

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

/** Streaming provider mock: captures every request message. */
function capturingProvider(captured: NormalizedMessageParam[]): LLMProvider {
  return {
    apiType: 'anthropic-messages',
    async createMessage() {
      throw new Error('not used')
    },
    async *createMessageStream(_params: CreateMessageParams): AsyncGenerator<StreamChunk> {
      captured.push(..._params.messages)
      yield { type: 'text', index: 0, delta: 'ok' }
      yield { type: 'done', index: -1 }
    },
  }
}

/** Agent wired with a capturing streaming provider (includePartialMessages on). */
function makeStreamingAgent(captured: NormalizedMessageParam[]): Agent {
  const agent = new Agent(makeBaseOptions({ includePartialMessages: true }))
  ;(agent as unknown as { provider: LLMProvider }).provider = capturingProvider(captured)
  return agent
}

describe('AgentInput: rich content through public APIs (issue #60)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const imageInput: AgentInput = [
    { type: 'text', text: 'what is in this picture?' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } },
  ]

  it('Agent.query() passes text+image blocks to the provider intact', async () => {
    const captured: NormalizedMessageParam[] = []
    const agent = makeStreamingAgent(captured)

    for await (const _ev of agent.query(imageInput)) {
      // drain
    }

    // Blocks reach the provider unmodified — not stringified, dropped, or rewritten.
    const userMsg = captured.find((m) => m.role === 'user')
    expect(userMsg).toBeDefined()
    expect(userMsg!.content).toEqual(imageInput)

    // messageLog records the rich content under the user entry.
    const entry = agent.getMessageLog().find((e) => e.type === 'user')
    expect(entry?.message.content).toEqual(imageInput)
  })

  it('Agent.query() with a plain string keeps existing behavior', async () => {
    const captured: NormalizedMessageParam[] = []
    const agent = makeStreamingAgent(captured)

    for await (const _ev of agent.query('hello')) {
      // drain
    }

    const userMsg = captured.find((m) => m.role === 'user')
    expect(userMsg?.content).toBe('hello')
    expect(agent.getMessageLog().find((e) => e.type === 'user')?.message.content).toBe('hello')
  })

  it('Agent.prompt() accepts text+image blocks; messages carry them verbatim', async () => {
    const captured: NormalizedMessageParam[] = []
    const agent = makeStreamingAgent(captured)

    const result = await agent.prompt(imageInput)

    expect(result.is_error).not.toBe(true)
    expect(result.text).toBe('ok')
    const userMsg = captured.find((m) => m.role === 'user')
    expect(userMsg?.content).toEqual(imageInput)
    expect(result.messages.find((e) => e.type === 'user')?.message.content).toEqual(imageInput)
  })

  it('top-level query() accepts text+image blocks (hook observes them; blocked before provider)', async () => {
    let hookSaw: unknown
    const events: SDKMessage[] = []
    for await (const ev of query({
      prompt: imageInput,
      options: makeBaseOptions({
        hooks: {
          UserPromptSubmit: [{
            hooks: [async (ctx: HookInput) => { hookSaw = ctx.toolInput; return { block: true } }],
          }],
        },
      }),
    })) {
      events.push(ev)
    }

    // Rich content passed through the public seam into the hook context;
    // the query terminated with the standard hook-block error result —
    // no provider needed for this end-to-end path.
    expect(hookSaw).toEqual(imageInput)
    const result = events.find((e) => e.type === 'result')
    expect(result?.is_error).toBe(true)
    expect(result?.errors?.join(' ')).toContain('Blocked by UserPromptSubmit')
  })
})

describe('AgentInput snapshot integrity (issue #60 review)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** The content as submitted — what every downstream observer must see. */
  function originalBlocks(): ContentBlockParam[] {
    return [
      { type: 'text', text: 'original' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } },
    ]
  }

  it('caller mutation after the first user event cannot corrupt the query (provider + messageLog)', async () => {
    const captured: NormalizedMessageParam[] = []
    const agent = makeStreamingAgent(captured)

    type ImageBlock = Extract<ContentBlockParam, { type: 'image' }>
    const imgBlock: ImageBlock = {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' },
    }
    const blocks: ContentBlockParam[] = [{ type: 'text', text: 'original' }, imgBlock]

    for await (const ev of agent.query(blocks)) {
      if (ev.type === 'user') {
        // Caller mutates the submitted array mid-flight: replaces the text
        // block AND rewrites the image block's nested source in place.
        blocks[0] = { type: 'text', text: 'mutated-after-yield' }
        imgBlock.source = { type: 'base64', media_type: 'image/jpeg', data: 'bXV0YXRlZA==' }
      }
    }

    const expected = originalBlocks()
    const userMsg = captured.find((m) => m.role === 'user')
    expect(userMsg?.content).toEqual(expected)
    expect(agent.getMessageLog().find((e) => e.type === 'user')?.message.content).toEqual(expected)
  })

  it('persisted transcript records the content as submitted, not as later mutated', async () => {
    const sessionId = `agent-input-snapshot-${crypto.randomUUID()}`
    const captured: NormalizedMessageParam[] = []
    const agent = new Agent(makeBaseOptions({
      includePartialMessages: true,
      persistSession: true,
      sessionId,
    }))
    ;(agent as unknown as { provider: LLMProvider }).provider = capturingProvider(captured)

    const blocks: ContentBlockParam[] = [
      { type: 'text', text: 'original' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } },
    ]

    try {
      for await (const ev of agent.query(blocks)) {
        if (ev.type === 'user') {
          blocks[0] = { type: 'text', text: 'mutated-after-yield' }
        }
      }

      const data = await loadSession(sessionId)
      expect(data).not.toBeNull()
      const userMsg = data!.messages.find((m) => m.role === 'user')
      expect(userMsg?.content).toEqual(originalBlocks())
    } finally {
      await deleteSession(sessionId)
    }
  })

  it('UserPromptSubmit hook mutating ctx.toolInput in place cannot corrupt the query', async () => {
    const sessionId = `agent-input-hookmut-${crypto.randomUUID()}`
    const captured: NormalizedMessageParam[] = []
    const agent = new Agent(makeBaseOptions({
      includePartialMessages: true,
      persistSession: true,
      sessionId,
      hooks: {
        UserPromptSubmit: [{
          hooks: [async (ctx: HookInput) => {
            // In-place mutation of the hook-visible input — no replacement,
            // no return value: just corrupt the object the SDK handed over.
            const blocks = ctx.toolInput as ContentBlockParam[]
            blocks[0] = { type: 'text', text: 'mutated-by-hook' }
            return {}
          }],
        }],
      },
    }))
    ;(agent as unknown as { provider: LLMProvider }).provider = capturingProvider(captured)

    const blocks: ContentBlockParam[] = [{ type: 'text', text: 'original' }]
    try {
      for await (const _ev of agent.query(blocks)) {
        // drain
      }

      // Every observer — provider request, message log, and persisted
      // transcript — records the content as submitted. Before the hook-input
      // clone, the hook's in-place mutation reached provider/history/
      // transcript as 'mutated-by-hook' while messageLog kept 'original' —
      // an audit/persistence divergence.
      const expected: ContentBlockParam[] = [{ type: 'text', text: 'original' }]
      expect(captured.find((m) => m.role === 'user')?.content).toEqual(expected)
      expect(agent.getMessageLog().find((e) => e.type === 'user')?.message.content).toEqual(expected)
      const data = await loadSession(sessionId)
      expect(data).not.toBeNull()
      expect(data!.messages.find((m) => m.role === 'user')?.content).toEqual(expected)
    } finally {
      await deleteSession(sessionId)
    }
  })
})

describe('root capabilities seam (issue #72, PR #73 review)', () => {
  // Public-seam observation: capture the tool schemas the PROVIDER receives
  // on createMessage — exactly the model-visible resolved eager pool.
  function captureToolsProvider() {
    const seenTools: any[][] = []
    const provider = {
      apiType: 'anthropic-messages' as const,
      createMessage: vi.fn(async (params: any) => {
        seenTools.push(params.tools ?? [])
        return {
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: 'end_turn',
        }
      }),
      createMessageStream: async function* () { /* not used */ },
    }
    return { provider, seenTools }
  }

  const capTool = (name: string, description = `${name} desc`) => ({
    name,
    description,
    inputSchema: { type: 'object' as const, properties: {} },
    call: async () => ({ type: 'tool_result' as const, tool_use_id: '', content: 'ok' }),
  })

  it('agent.capabilities.customTools union with top-level customTools', async () => {
    const { provider, seenTools } = captureToolsProvider()
    const agent = new Agent(makeBaseOptions({
      customTools: [capTool('top_custom') as any],
      agent: {
        description: 'root', prompt: 'p',
        capabilities: { customTools: [capTool('cap_custom') as any] },
      },
    }))
    ;(agent as any).provider = provider
    await agent.prompt('hi')
    const names = seenTools[0].map((t: any) => t.name)
    expect(names).toContain('top_custom')
    expect(names).toContain('cap_custom')
  })

  it('agent.capabilities.connectionTools union with the mcpServers pool', async () => {
    const { provider, seenTools } = captureToolsProvider()
    const sdk = createSdkMcpServer({ name: 'mylocal', tools: [greetTool()], deferred: false })
    const agent = new Agent(makeBaseOptions({
      mcpServers: { mylocal: sdk },
      agent: {
        description: 'root', prompt: 'p',
        capabilities: { connectionTools: [capTool('mcp__cap__op') as any] },
      },
    }))
    ;(agent as any).provider = provider
    await agent.prompt('hi')
    const names = seenTools[0].map((t: any) => t.name)
    expect(names).toContain('mcp__mylocal__greet')   // top-level mcpServers pool
    expect(names).toContain('mcp__cap__op')          // capabilities.connectionTools
  })

  it('same-name capability tool overrides its top-level twin (later-wins dedup)', async () => {
    const { provider, seenTools } = captureToolsProvider()
    const agent = new Agent(makeBaseOptions({
      customTools: [capTool('dup', 'top-level twin') as any],
      agent: {
        description: 'root', prompt: 'p',
        capabilities: { customTools: [capTool('dup', 'capability twin') as any] },
      },
    }))
    ;(agent as any).provider = provider
    await agent.prompt('hi')
    const dups = seenTools[0].filter((t: any) => t.name === 'dup')
    expect(dups).toHaveLength(1)
    expect(dups[0].description).toBe('capability twin')
  })

  it('per-query agent definition capabilities honored (no cfg/definition disconnect)', async () => {
    const { provider, seenTools } = captureToolsProvider()
    const agent = new Agent(makeBaseOptions())  // constructor has NO agent definition
    ;(agent as any).provider = provider
    await agent.prompt('hi', {
      agent: {
        description: 'q', prompt: 'p',
        capabilities: { customTools: [capTool('per_query_custom') as any] },
      },
    })
    const names = seenTools[0].map((t: any) => t.name)
    expect(names).toContain('per_query_custom')
  })

  it('top-level sources unchanged without capabilities (no regression)', async () => {
    const { provider, seenTools } = captureToolsProvider()
    const sdk = createSdkMcpServer({ name: 'mylocal', tools: [greetTool()], deferred: false })
    const agent = new Agent(makeBaseOptions({
      mcpServers: { mylocal: sdk },
      customTools: [capTool('top_custom') as any],
    }))
    ;(agent as any).provider = provider
    await agent.prompt('hi')
    const names = seenTools[0].map((t: any) => t.name)
    expect(names).toContain('mcp__mylocal__greet')
    expect(names).toContain('top_custom')
  })
})

describe('Agent MCP failure log sanitization (issue #77)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('Skipped log omits connection error text', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      vi.mocked(acquireMCPConnection).mockResolvedValueOnce({
        name: 'prod-db',
        status: 'error',
        tools: [],
        error: new Error('handshake failed: https://user:sekret@host/api'),
        close: async () => {},
      } as any)
      const agent = new Agent(makeBaseOptions({
        mcpServers: { 'prod-db': { type: 'stdio', command: 'echo' } },
      }))

      await getPoolTools(agent)

      expect(warnSpy).toHaveBeenCalledTimes(1)
      const [msg, fields] = warnSpy.mock.calls[0]
      expect(msg).toBe('[MCP] Skipped server')
      expect(JSON.stringify(warnSpy.mock.calls[0])).not.toContain('sekret')
      expect(JSON.stringify(warnSpy.mock.calls[0])).not.toContain('https://user')
      expect(fields.errorType).toBe('Error')
      expect(fields.server).toBe('"prod-db"')
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('connect-throw log omits error text', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      vi.mocked(acquireMCPConnection).mockRejectedValueOnce(
        new Error('spawn ENOENT /home/u/secret-path/bin token=x'),
      )
      const agent = new Agent(makeBaseOptions({
        mcpServers: { 'prod-db': { type: 'stdio', command: 'echo' } },
      }))

      await getPoolTools(agent)

      expect(errSpy).toHaveBeenCalledTimes(1)
      const [msg, fields] = errSpy.mock.calls[0]
      expect(msg).toBe('[MCP] Failed to connect to server')
      expect(JSON.stringify(errSpy.mock.calls[0])).not.toContain('secret-path')
      expect(JSON.stringify(errSpy.mock.calls[0])).not.toContain('token=x')
      expect(fields.errorType).toBe('Error')
    } finally {
      vi.restoreAllMocks()
    }
  })
})

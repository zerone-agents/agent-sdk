import { describe, it, expect, vi, beforeEach } from 'vitest'
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

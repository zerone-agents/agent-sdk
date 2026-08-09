import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { Agent } from './agent.js'
import { createSdkMcpServer } from './sdk-mcp-server.js'
import { tool } from './tool-helper.js'
import type { AgentOptions } from './types.js'

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

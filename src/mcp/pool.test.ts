import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// mock buildMCPClient while keeping createMCPToolDefinition (real) and types intact
vi.mock('./client.js', async (importOriginal) => {
  const actual = await importOriginal() as any
  return {
    ...actual,
    buildMCPClient: vi.fn(),
  }
})

import {
  acquireMCPConnection,
  releaseMCPConnection,
  __clearPoolForTests,
} from './pool.js'
import { buildMCPClient, createMCPToolDefinition } from './client.js'
import type { McpServerConfig } from '../types.js'

const stdioConfig = (overrides: Partial<{ command: string; args: string[]; env: Record<string, string> }> = {}): McpServerConfig => ({
  type: 'stdio',
  command: 'echo',
  args: [],
  ...overrides,
})

interface MockBuilt {
  client: { close: ReturnType<typeof vi.fn>; callTool: ReturnType<typeof vi.fn> }
  rawTools: any[]
  close: ReturnType<typeof vi.fn>
}

function mockBuiltClient(tools: any[] = [{ name: 'tool1', description: 'd', inputSchema: {} }]): MockBuilt {
  const client = {
    close: vi.fn().mockResolvedValue(undefined),
    callTool: vi.fn().mockResolvedValue({ content: [] }),
  }
  return {
    client,
    rawTools: tools,
    close: vi.fn().mockResolvedValue(undefined),
  }
}

describe('MCP connection pool', () => {
  beforeEach(() => {
    __clearPoolForTests()
    vi.useFakeTimers()
    vi.mocked(buildMCPClient).mockReset()
    // default impl: fresh mock each call (so test cases can detect double-spawn)
    vi.mocked(buildMCPClient).mockImplementation(async () => {
      const built = mockBuiltClient()
      return built
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('returns same underlying client for identical transport config', async () => {
    const builtA = mockBuiltClient()
    const builtB = mockBuiltClient()
    vi.mocked(buildMCPClient)
      .mockResolvedValueOnce(builtA)
      .mockResolvedValueOnce(builtB)

    const connA = await acquireMCPConnection('srv', stdioConfig({ args: ['x'] }))
    const connB = await acquireMCPConnection('srv', stdioConfig({ args: ['x'] }))

    expect(buildMCPClient).toHaveBeenCalledTimes(1)
    // both connections wrap the same underlying client (builtA)
    // We can verify by checking that calling the tool goes through builtA.client
    expect(connA.status).toBe('connected')
    expect(connB.status).toBe('connected')

    await releaseMCPConnection(connA)
    await releaseMCPConnection(connB)
  })

  it('creates separate clients for different args', async () => {
    const builtA = mockBuiltClient()
    const builtB = mockBuiltClient()
    vi.mocked(buildMCPClient)
      .mockResolvedValueOnce(builtA)
      .mockResolvedValueOnce(builtB)

    const connA = await acquireMCPConnection('srv', stdioConfig({ args: ['x'] }))
    const connB = await acquireMCPConnection('srv', stdioConfig({ args: ['y'] }))

    expect(buildMCPClient).toHaveBeenCalledTimes(2)
    expect(connA.status).toBe('connected')
    expect(connB.status).toBe('connected')

    await releaseMCPConnection(connA)
    await releaseMCPConnection(connB)
  })

  it('refCount decrements on release, spawns close timer at zero', async () => {
    const built = mockBuiltClient()
    vi.mocked(buildMCPClient).mockResolvedValueOnce(built)

    const connA = await acquireMCPConnection('srv', stdioConfig({ command: 'c1' }))
    const connB = await acquireMCPConnection('srv', stdioConfig({ command: 'c1' }))

    expect(buildMCPClient).toHaveBeenCalledTimes(1)

    // first release: refCount 2 -> 1, no timer scheduled
    await releaseMCPConnection(connA)
    expect(built.close).not.toHaveBeenCalled()

    // advance some time; nothing should close
    await vi.advanceTimersByTimeAsync(60_000)
    expect(built.close).not.toHaveBeenCalled()

    // second release: refCount 1 -> 0, timer scheduled
    await releaseMCPConnection(connB)

    // before grace elapses, client still alive
    await vi.advanceTimersByTimeAsync(29_000)
    expect(built.close).not.toHaveBeenCalled()
  })

  it('cancels close timer when re-acquired within grace period', async () => {
    const built = mockBuiltClient()
    vi.mocked(buildMCPClient).mockResolvedValueOnce(built)

    const conn = await acquireMCPConnection('srv', stdioConfig({ command: 'cancel' }))
    await releaseMCPConnection(conn)

    // advance near (but not past) grace period
    await vi.advanceTimersByTimeAsync(29_000)
    expect(built.close).not.toHaveBeenCalled()

    // re-acquire with the same config: should clear the timer and reuse entry
    const conn2 = await acquireMCPConnection('srv', stdioConfig({ command: 'cancel' }))

    // buildMCPClient should NOT have been called again (reused)
    expect(buildMCPClient).toHaveBeenCalledTimes(1)
    expect(conn2.status).toBe('connected')

    // advance past original grace deadline: client must NOT close (timer cleared)
    await vi.advanceTimersByTimeAsync(35_000)
    expect(built.close).not.toHaveBeenCalled()

    await releaseMCPConnection(conn2)
  })

  it('actually closes client after grace period elapses', async () => {
    const built = mockBuiltClient()
    vi.mocked(buildMCPClient).mockResolvedValueOnce(built)

    const conn = await acquireMCPConnection('srv', stdioConfig({ command: 'shutdown' }))
    await releaseMCPConnection(conn)

    // advance past grace (30s default)
    await vi.advanceTimersByTimeAsync(31_000)

    expect(built.close).toHaveBeenCalledTimes(1)

    // pool should now be empty: a new acquire should call buildMCPClient again
    const built2 = mockBuiltClient()
    vi.mocked(buildMCPClient).mockResolvedValueOnce(built2)
    const conn2 = await acquireMCPConnection('srv', stdioConfig({ command: 'shutdown' }))
    expect(buildMCPClient).toHaveBeenCalledTimes(2)
    await releaseMCPConnection(conn2)
  })

  it('different serverName produces tools with that name prefix', async () => {
    const built = mockBuiltClient([{ name: 'lookup', inputSchema: {} }])
    vi.mocked(buildMCPClient).mockResolvedValueOnce(built)

    const connA = await acquireMCPConnection('agentA', stdioConfig({ command: 'shared' }))
    const connB = await acquireMCPConnection('agentB', stdioConfig({ command: 'shared' }))

    expect(connA.tools).toHaveLength(1)
    expect(connB.tools).toHaveLength(1)
    expect(connA.tools[0].name).toBe('mcp__agentA__lookup')
    expect(connB.tools[0].name).toBe('mcp__agentB__lookup')

    // both share one underlying spawn
    expect(buildMCPClient).toHaveBeenCalledTimes(1)

    await releaseMCPConnection(connA)
    await releaseMCPConnection(connB)
  })

  it('does not pool when buildMCPClient throws', async () => {
    vi.mocked(buildMCPClient).mockRejectedValueOnce(new Error('spawn failed'))

    const conn = await acquireMCPConnection('srv', stdioConfig({ command: 'broken' }))

    expect(conn.status).toBe('error')
    expect(conn.tools).toEqual([])
    expect(conn.error).toBeInstanceOf(Error)

    // pool should not contain this entry; a subsequent acquire with the same
    // config must call buildMCPClient again rather than returning a stale error
    const built = mockBuiltClient()
    vi.mocked(buildMCPClient).mockResolvedValueOnce(built)
    const conn2 = await acquireMCPConnection('srv', stdioConfig({ command: 'broken' }))
    expect(conn2.status).toBe('connected')
    expect(buildMCPClient).toHaveBeenCalledTimes(2)

    await releaseMCPConnection(conn2)
  })
})

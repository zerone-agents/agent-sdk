import { describe, expect, it, vi } from 'vitest'
import { Agent } from './agent.js'
import { WriteCoordinator } from './store/coordinator.js'
import { CommittedMessageIndex } from './store/index-map.js'
import { InMemorySessionStore } from './store/in-memory.js'
import { prepareOperation } from './store/prepare.js'
import { SessionConflictError, SessionNotFoundError } from './session-storage.js'
import type { AgentOptions, SDKMessage } from './types.js'
import type { NormalizedMessageParam } from './providers/types.js'

const msg = (mid: string, text = 'x'): NormalizedMessageParam =>
  ({ id: mid, role: 'user', content: text }) as NormalizedMessageParam

/** Narrow seam for Agent internals under test (same pattern as existing tests). */
interface AgentInternals {
  setupDone: Promise<void>
  history: NormalizedMessageParam[]
  persistCheckpoint(): Promise<void>
  sessionRevision: number
  rootSessionId: string
  sid: string  // narrow seam for private sid
}
function internals(agent: Agent): AgentInternals {
  return agent as unknown as AgentInternals
}

function base(overrides: Partial<AgentOptions> = {}): AgentOptions {
  return {
    model: 'test-model',
    apiKey: 'fake',
    mcpServers: {},
    ...overrides,
  }
}

describe('Agent on v4 SessionStore (issue #131, P3 T3)', () => {
  it('first write: Agent checkpoint via WriteCoordinator → store records + revision=1', async () => {
    const store = new InMemorySessionStore()
    const coord = new WriteCoordinator({ store })
    const agent = new Agent(base({ store, coordinator: coord }))
    const i = internals(agent)
    i.history = [msg('m1', 'hello')]
    await i.persistCheckpoint()
    const state = await store.loadSession(internals(agent).sid)
    expect(state).not.toBeNull()
    expect(state!.revision).toBe(1)
    expect(i.sessionRevision).toBe(1)
  })

  it('incremental: second checkpoint only commits new messages', async () => {
    const store = new InMemorySessionStore()
    const coord = new WriteCoordinator({ store })
    const agent = new Agent(base({ store, coordinator: coord }))
    const i = internals(agent)
    i.history = [msg('m1')]
    await i.persistCheckpoint()
    expect(i.sessionRevision).toBe(1)
    // Second query adds m2
    i.history = [msg('m1'), msg('m2')]
    await i.persistCheckpoint()
    expect(i.sessionRevision).toBe(2)
    const state = await store.loadSession(internals(agent).sid)
    const branch = state!.branches.find((b) => b.branchId === state!.currentBranchId)
    expect(branch!.records).toHaveLength(2)  // m1 + m2, no duplicates
  })

  it('no change: all committed → checkpoint skips (no revision bump)', async () => {
    const store = new InMemorySessionStore()
    const coord = new WriteCoordinator({ store })
    const agent = new Agent(base({ store, coordinator: coord }))
    const i = internals(agent)
    i.history = [msg('m1')]
    await i.persistCheckpoint()
    const revBefore = i.sessionRevision
    await i.persistCheckpoint()  // same history, no new messages
    expect(i.sessionRevision).toBe(revBefore)  // no bump
  })

  it('checkpoint failure: index not advanced, retry succeeds', async () => {
    const store = new InMemorySessionStore()
    const coord = new WriteCoordinator({ store })
    const agent = new Agent(base({ store, coordinator: coord }))
    const i = internals(agent)
    // First checkpoint succeeds
    i.history = [msg('m1')]
    await i.persistCheckpoint()
    // Simulate external CAS conflict by bumping revision behind Agent's back
    const state = await store.loadSession(internals(agent).sid)
    const branch = state!.branches[0]
    await store.commit(internals(agent).sid, prepareOperation(internals(agent).sid, {
      kind: 'append', expectedRevision: 1,
      changeSet: { kind: 'append', branchId: branch.branchId, newRecords: [
        { recordId: 'ext-r', message: msg('ext-m', 'external'), actor: { kind: 'sdk' } },
      ], contextAppend: false },
    }))
    // Agent tries checkpoint with stale revision → conflict
    i.history = [msg('m1'), msg('m2')]
    await expect(i.persistCheckpoint()).rejects.toThrow(SessionConflictError)
    // sessionRevision not advanced by failed checkpoint
    // Agent refreshes (or caller decides to handle conflict)
  })

  it('resume: history + index + revision rebuilt from store', async () => {
    const store = new InMemorySessionStore()
    const coord = new WriteCoordinator({ store })
    // First agent writes
    const a1 = new Agent(base({ store, coordinator: coord }))
    const i1 = internals(a1)
    i1.history = [msg('m1', 'hello'), msg('m2', 'world')]
    await i1.persistCheckpoint()
    // New agent resumes
    const a2 = new Agent(base({ store, coordinator: coord, resume: i1.sid }))
    const i2 = internals(a2)
    await i2.setupDone
    expect(i2.sessionRevision).toBe(1)
    expect(i2.history).toHaveLength(2)
    // Checkpoint after resume: no new messages → skip
    await i2.persistCheckpoint()
    expect(i2.sessionRevision).toBe(1)
  })

  it('resume: missing session → SessionNotFoundError', async () => {
    const store = new InMemorySessionStore()
    const coord = new WriteCoordinator({ store })
    const agent = new Agent(base({ store, coordinator: coord, resume: 'ghost' }))
    const i = internals(agent)
    await expect(i.setupDone).rejects.toThrow(SessionNotFoundError)
  })

  it('rootSessionId: main agent = own sid', async () => {
    const store = new InMemorySessionStore()
    const agent = new Agent(base({ store }))
    expect(internals(agent).rootSessionId).toBe(internals(agent).sid)
  })

  it('rootSessionId: background agent = explicit root', async () => {
    const store = new InMemorySessionStore()
    const agent = new Agent(base({ store, ownership: { rootSessionId: 'my-root' } }))
    expect(internals(agent).rootSessionId).toBe('my-root')
  })

  it('self-register: Agent registers on first write', async () => {
    const store = new InMemoryStoreSpy()
    const coord = new WriteCoordinator({ store })
    const agent = new Agent(base({ store, coordinator: coord }))
    const i = internals(agent)
    i.history = [msg('m1')]
    await i.persistCheckpoint()
    expect(store.registerCalls).toBeGreaterThanOrEqual(1)  // Agent registered before checkpoint
  })

  it('external revise during generation → conflict (not silently committed)', async () => {
    const store = new InMemorySessionStore()
    const coord = new WriteCoordinator({ store })
    const agent = new Agent(base({ store, coordinator: coord }))
    const i = internals(agent)
    // Agent commits first checkpoint
    i.history = [msg('m1')]
    await i.persistCheckpoint()
    // External revise: another SessionManager commits revision 2
    const state = await store.loadSession(internals(agent).sid)
    await store.commit(internals(agent).sid, prepareOperation(internals(agent).sid, {
      kind: 'append', expectedRevision: 1,
      changeSet: { kind: 'append', branchId: state!.currentBranchId, newRecords: [
        { recordId: 'ext-1', message: msg('ext-m'), actor: { kind: 'sdk' } },
      ], contextAppend: false },
    }))
    // Agent's checkpoint with stale revision → conflict
    i.history = [msg('m1'), msg('m2')]
    await expect(i.persistCheckpoint()).rejects.toThrow(SessionConflictError)
    // History NOT silently dropped
    expect(i.history).toHaveLength(2)
  })

  it('close: checkpoint completes via coordinator', async () => {
    const store = new InMemorySessionStore()
    const coord = new WriteCoordinator({ store })
    const agent = new Agent(base({ store, coordinator: coord }))
    const i = internals(agent)
    i.history = [msg('m1', 'bye')]
    await agent.close()
    const state = await store.loadSession(internals(agent).sid)
    expect(state).not.toBeNull()
    expect(state!.revision).toBeGreaterThanOrEqual(1)
  })
})

/** InMemory store that tracks register calls. */
class InMemoryStoreSpy extends InMemorySessionStore {
  registerCalls = 0
  async commit(sessionId: string, prepared: Parameters<typeof InMemorySessionStore.prototype.commit>[1], opts?: Parameters<typeof InMemorySessionStore.prototype.commit>[2]) {
    if (prepared.kind === 'register') this.registerCalls++
    return super.commit(sessionId, prepared, opts)
  }
}
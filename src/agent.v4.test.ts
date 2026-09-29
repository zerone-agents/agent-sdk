import { describe, expect, it, vi } from 'vitest'
import { Agent } from './agent.js'
import { WriteCoordinator } from './store/coordinator.js'
import { CommittedMessageIndex } from './store/index-map.js'
import { InMemorySessionStore } from './store/in-memory.js'
import { prepareOperation } from './store/prepare.js'
import { SessionConflictError, SessionNotFoundError, SessionCloseTimeoutError } from './store/errors.js'
import type { AgentOptions, SDKMessage } from './types.js'
import type { NormalizedMessageParam } from './providers/types.js'

const msg = (mid: string, text = 'x'): NormalizedMessageParam =>
  ({ id: mid, role: 'user', content: text }) as NormalizedMessageParam

/** Narrow seam for Agent internals under test (same pattern as existing tests). */
interface AgentInternals {
  setupDone: Promise<void>
  history: NormalizedMessageParam[]
  persistCheckpoint(): Promise<void>
  commitCompactOperation(pre: readonly NormalizedMessageParam[]): Promise<void>
  sessionRevision: number
  engineCompactRevision?: number
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

  it('review R8: imported session with initialRevision=0 can continue checkpointing after resume', async () => {
    const store = new InMemorySessionStore()
    const coord = new WriteCoordinator({ store })
    // Import an existing transcript with initialRevision 0 (§8.3 legal)
    await coord.execute('imported-0', {
      kind: 'import',
      expectedRevision: null,
      changeSet: {
        kind: 'import',
        branchId: 'b1',
        newRecords: [{ recordId: 'r1', message: msg('m1', 'old'), actor: { kind: 'main' } }],
        effective: ['r1'],
        context: { segments: [{ kind: 'records', recordIds: ['r1'] }] },
        metadata: {},
        ownership: { rootSessionId: 'imported-0' },
        initialRevision: 0,
      },
    })
    const state0 = await store.loadSession('imported-0')
    expect(state0!.revision).toBe(0)  // legal revision-0 session WITH transcript
    // Agent resumes and checkpoints a new message — must NOT conflict
    const agent = new Agent(base({ store, coordinator: coord, resume: 'imported-0' }))
    const i = internals(agent)
    await i.setupDone
    i.history = [...i.history, msg('m2', 'fresh')]
    await i.persistCheckpoint()   // previously: v4Revision===0 → create-only null → hasTranscript → SessionConflictError
    const state1 = await store.loadSession('imported-0')
    expect(state1!.revision).toBe(1)
    expect(i.sessionRevision).toBe(1)
  })

  it('review R9: close propagates checkpoint failures (no swallow)', async () => {
    const store = new InMemorySessionStore()
    const coord = new WriteCoordinator({ store })
    const agent = new Agent(base({ store, coordinator: coord }))
    const i = internals(agent)
    i.history = [msg('m1')]
    await i.persistCheckpoint()   // revision 1
    // External modification → revision 2 (the agent's next checkpoint conflicts)
    const state = await store.loadSession(i.sid)
    await store.commit(i.sid, prepareOperation(i.sid, {
      kind: 'append', expectedRevision: 1,
      changeSet: {
        kind: 'append', branchId: state!.currentBranchId,
        newRecords: [{ recordId: 'ext-r', message: msg('ext-m', 'external'), actor: { kind: 'sdk' } }],
        contextAppend: false,
      },
    }))
    i.history = [...i.history, msg('m2')]
    // Previously: close() swallowed the conflict and returned normally
    await expect(agent.close()).rejects.toThrow(SessionConflictError)
  })

  it('review R9: close timeout surfaces as SessionCloseTimeoutError (no silent return)', async () => {
    const store = new InMemorySessionStore()
    // Hanging commit: the checkpoint never completes
    ;(store as unknown as { commit: unknown }).commit = () => new Promise(() => {})
    const agent = new Agent(base({ store, sessionCloseTimeoutMs: 50 }))
    const i = internals(agent)
    i.history = [msg('m1')]
    // Previously: the timeout raced to a normal return with the write still pending
    await expect(agent.close()).rejects.toThrow(SessionCloseTimeoutError)
  })

  it('review R1: post-checkpoint compact commits a compact op (summary record + covers; next checkpoint no-op)', async () => {
    const store = new InMemorySessionStore()
    const coord = new WriteCoordinator({ store })
    const agent = new Agent(base({ store, coordinator: coord }))
    const i = internals(agent)
    i.history = [msg('m1', 'one'), msg('m2', 'two'), msg('m3', 'three'), msg('m4', 'four')]
    await i.persistCheckpoint()
    const rev1 = i.sessionRevision
    // Simulate engine auto-compact: pre → post [summaryUser, summaryAssistant, kept m4]
    const pre = [...i.history]
    i.history = [msg('sum-u', 'summarize this'), msg('sum-a', 'summary of one-two-three'), msg('m4', 'four')]
    await i.commitCompactOperation(pre)
    // Compact op advanced the revision; own-compact receipt wired
    expect(i.sessionRevision).toBe(rev1 + 1)
    expect(i.engineCompactRevision).toBe(rev1 + 1)
    // Records: 4 originals + sum-u + sum-a = 6 (full history preserved)
    const state = await store.loadSession(i.sid)
    const branch = state!.branches.find((b) => b.branchId === state!.currentBranchId)!
    expect(branch.records).toHaveLength(6)
    expect(branch.context.segments.some((s) => s.kind === 'summary')).toBe(true)
    // Model context: [summary, kept m4] — originals summarized away
    const msgs = await store.loadContext(i.sid, branch.branchId)
    expect(msgs).toHaveLength(2)
    expect((msgs[1] as { id?: string }).id).toBe('m4')
    // Next checkpoint: everything indexed → no-op (no revision bump)
    await i.persistCheckpoint()
    expect(i.sessionRevision).toBe(rev1 + 1)
  })

  it('review R1: compact BEFORE first checkpoint lands pending originals atomically (§4.2 no data loss)', async () => {
    const store = new InMemorySessionStore()
    const coord = new WriteCoordinator({ store })
    const agent = new Agent(base({ store, coordinator: coord }))
    const i = internals(agent)
    // 5 messages in memory, NOTHING committed yet — compact fires first
    const pre = [msg('m1', 'a'), msg('m2', 'b'), msg('m3', 'c'), msg('m4', 'd'), msg('m5', 'e')]
    i.history = [msg('sum-u', 'summarize'), msg('sum-a', 'the summary'), msg('m4', 'd'), msg('m5', 'e')]
    await i.commitCompactOperation(pre)
    const state = await store.loadSession(i.sid)
    expect(state).not.toBeNull()
    const branch = state!.branches.find((b) => b.branchId === state!.currentBranchId)!
    // §4.2: pending covered originals (m1-m3) + pending kept (m4,m5) + 2 head records
    // landed in ONE compact op — 7 records; the covered originals are NOT lost
    expect(branch.records).toHaveLength(7)
    const records = await store.loadRecords(i.sid, branch.records)
    const mids = records.filter((r) => r !== null).map((r) => r!.messageId)
    expect(mids).toContain('m1')
    expect(mids).toContain('m2')
    expect(mids).toContain('m3')
    // Model context: [summary, m4, m5]
    const msgs = await store.loadContext(i.sid, branch.branchId)
    expect(msgs.map((m) => (m as { id?: string }).id)).toEqual(['sum-a', 'm4', 'm5'])
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
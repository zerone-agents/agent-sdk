import { describe, expect, it } from 'vitest'
import { createSessionManagerV2 } from './session-manager.js'
import { InMemorySessionStore } from './in-memory.js'
import { WriteCoordinator } from './coordinator.js'
import type { NewRecord } from './types.js'

const rec = (rid: string, mid: string, text: string): NewRecord => ({
  recordId: rid,
  message: { id: mid, role: 'user', content: text },
  actor: { kind: 'main' },
})

/** Seed: register + checkpoint 3 messages (m1 hello / m2 hi there / m3 bye). */
async function seed(store: InMemorySessionStore, coord: WriteCoordinator, sid = 's1'): Promise<void> {
  await coord.execute(sid, { kind: 'register', ownership: { rootSessionId: sid } })
  await coord.execute(sid, {
    kind: 'checkpoint', expectedRevision: null,
    changeSet: {
      kind: 'checkpoint', branchId: 'b1',
      newRecords: [rec('r1', 'm1', 'hello'), rec('r2', 'm2', 'hi there'), rec('r3', 'm3', 'bye')],
      metadataPatch: {},
    },
  })
}

describe('SessionManager v2 (issue #131 P3 T6)', () => {
  it('get: existing → state; missing → null', async () => {
    const store = new InMemorySessionStore()
    const coord = new WriteCoordinator({ store })
    await seed(store, coord)
    const mgr = createSessionManagerV2({ store, coordinator: coord })
    expect(await mgr.get('s1')).not.toBeNull()
    expect(await mgr.get('ghost')).toBeNull()
  })

  it('getMessages: returns context messages', async () => {
    const store = new InMemorySessionStore()
    const coord = new WriteCoordinator({ store })
    await seed(store, coord)
    const mgr = createSessionManagerV2({ store, coordinator: coord })
    const msgs = await mgr.getMessages('s1')
    expect(msgs).toHaveLength(3)
    expect((msgs[0] as { content: string }).content).toBe('hello')
  })

  it('getMessages: missing session → empty array', async () => {
    const store = new InMemorySessionStore()
    const mgr = createSessionManagerV2({ store })
    expect(await mgr.getMessages('ghost')).toEqual([])
  })

  it('revise: content replaced in context; old record stays in logs (append-only)', async () => {
    const store = new InMemorySessionStore()
    const coord = new WriteCoordinator({ store })
    await seed(store, coord)
    const mgr = createSessionManagerV2({ store, coordinator: coord })
    const receipt = await mgr.revise('s1', 'm2', 'REVISED')
    expect(receipt.revision).toBe(2)
    // Context now shows revised content
    const msgs = await mgr.getMessages('s1')
    expect((msgs[1] as { content: string }).content).toBe('REVISED')
    // Logs keep the old record (append-only): 3 original + 1 revision
    const state = await store.loadSession('s1')
    const branch = state!.branches.find((b) => b.branchId === 'b1')!
    expect(branch.records.length).toBe(4)
  })

  it('revise: missing message → throws', async () => {
    const store = new InMemorySessionStore()
    const coord = new WriteCoordinator({ store })
    await seed(store, coord)
    const mgr = createSessionManagerV2({ store, coordinator: coord })
    await expect(mgr.revise('s1', 'ghost-msg', 'x')).rejects.toThrow(/not found/)
  })

  it('rollback: context truncated at target; new branch becomes current', async () => {
    const store = new InMemorySessionStore()
    const coord = new WriteCoordinator({ store })
    await seed(store, coord)
    const mgr = createSessionManagerV2({ store, coordinator: coord })
    const receipt = await mgr.rollback('s1', 'm2')
    expect(receipt.revision).toBe(2)
    const state = await store.loadSession('s1')
    expect(state!.currentBranchId).not.toBe('b1')  // new branch current
    const msgs = await mgr.getMessages('s1')
    expect(msgs.length).toBeLessThanOrEqual(2)  // truncated at m2
  })

  it('fork: new session with copied records; source untouched', async () => {
    const store = new InMemorySessionStore()
    const coord = new WriteCoordinator({ store })
    await seed(store, coord)
    const mgr = createSessionManagerV2({ store, coordinator: coord })
    await mgr.fork('s1', 'fork-1')
    const forked = await store.loadSession('fork-1')
    expect(forked).not.toBeNull()
    const forkMsgs = await mgr.getMessages('fork-1')
    expect(forkMsgs).toHaveLength(3)
    // Source untouched
    const srcMsgs = await mgr.getMessages('s1')
    expect(srcMsgs).toHaveLength(3)
  })

  it('delete: tombstone; get → null', async () => {
    const store = new InMemorySessionStore()
    const coord = new WriteCoordinator({ store })
    await seed(store, coord)
    const mgr = createSessionManagerV2({ store, coordinator: coord })
    await mgr.delete('s1')
    expect(await mgr.get('s1')).toBeNull()
  })

  it('saveTodos/getTodos round-trip via manager', async () => {
    const store = new InMemorySessionStore()
    const coord = new WriteCoordinator({ store })
    await seed(store, coord)
    const mgr = createSessionManagerV2({ store, coordinator: coord })
    await mgr.saveTodos('s1', [{ content: 'task', status: 'pending', priority: 'high' }])
    const todos = await mgr.getTodos('s1')
    expect(todos).toHaveLength(1)
    expect(todos[0].content).toBe('task')
  })
})
import { describe, expect, it } from 'vitest'
import { createSessionManagerV2 } from './session-manager.js'
import { InMemorySessionStore } from './in-memory.js'
import { WriteCoordinator } from './coordinator.js'
import { prepareOperation } from './prepare.js'
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

  it('review R3: consecutive revises — context always shows the LATEST content', async () => {
    const store = new InMemorySessionStore()
    const coord = new WriteCoordinator({ store })
    await seed(store, coord)
    const mgr = createSessionManagerV2({ store, coordinator: coord })
    await mgr.revise('s1', 'm2', 'REVISED-1')
    await mgr.revise('s1', 'm2', 'REVISED-2')
    const msgs = await mgr.getMessages('s1')
    // 评审反例：original→first→second 两次提交成功后曾读到 first
    expect((msgs[1] as { content: string }).content).toBe('REVISED-2')
  })

  it('review R3: revising a summarized message invalidates the summary (§4.5 expansion)', async () => {
    const store = new InMemorySessionStore()
    const coord = new WriteCoordinator({ store })
    // compact: summary S1 covers m1（复用 index-map.test 的 compact 种子模式）
    await store.commit('s1', prepareOperation('s1', {
      kind: 'compact', expectedRevision: null,
      changeSet: {
        kind: 'compact', branchId: 'b1',
        newRecords: [
          rec('r1', 'm1', 'original'),
          { recordId: 'S1', message: { id: 'sum-1', role: 'assistant', content: 'sum' }, actor: { kind: 'sdk' }, kind: 'summary' },
        ],
        context: { segments: [{ kind: 'summary', summaryRecordId: 'S1', covers: { branchId: 'b1', recordIds: ['r1'] } }] },
        summary: { summaryRecordId: 'S1', covers: { branchId: 'b1', recordIds: ['r1'] } },
      },
    }))
    const mgr = createSessionManagerV2({ store, coordinator: coord })
    await mgr.revise('s1', 'm1', 'POST-SUMMARY-EDIT')
    const state = await store.loadSession('s1')
    const branch = state!.branches.find((b) => b.branchId === 'b1')!
    // 失效摘要不再保留：context 无 summary 段，原位展开为 records
    expect(branch.context.segments.some((s) => s.kind === 'summary')).toBe(false)
    const msgs = await mgr.getMessages('s1')
    expect((msgs[0] as { content: string }).content).toBe('POST-SUMMARY-EDIT')
  })

  it('review R10: append / list / getOperation / clearTodos planned entries', async () => {
    const store = new InMemorySessionStore()
    const coord = new WriteCoordinator({ store })
    await seed(store, coord)
    const mgr = createSessionManagerV2({ store, coordinator: coord })
    // append lands in context
    const receipt = await mgr.append('s1', { id: 'm4', role: 'user', content: 'appended' } as never)
    expect(receipt.revision).toBe(2)
    const msgs = await mgr.getMessages('s1')
    expect((msgs[3] as { content: string }).content).toBe('appended')
    // list enumerates (InMemory implements optional listSessions)
    const listed = await mgr.list()
    expect(listed.map((m) => m.id)).toContain('s1')
    // getOperation: committed → receipt; missing → null（三态，recycled 另抛）
    const q = await mgr.getOperation('s1', receipt.operationId)
    expect(q).not.toBeNull()
    expect(q!.operationId).toBe(receipt.operationId)
    expect(await mgr.getOperation('s1', 'never-existed')).toBeNull()
    // clearTodos empties the list
    await mgr.saveTodos('s1', [{ content: 't', status: 'pending', priority: 'high' }])
    await mgr.clearTodos('s1')
    expect(await mgr.getTodos('s1')).toEqual([])
  })
})
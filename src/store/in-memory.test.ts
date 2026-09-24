import { describe, expect, it } from 'vitest'
import { InMemorySessionStore } from './in-memory.js'
import { prepareOperation } from './prepare.js'
import { SessionConflictError } from './errors.js'
import type { NewRecord, OperationIntent } from './types.js'

const rec = (recordId: string, messageId: string, text = 'hi'): NewRecord =>
  ({ recordId, message: { id: messageId, role: 'user', content: text }, actor: { kind: 'main' } })
const ckpt = (expectedRevision: number | null, newRecords: NewRecord[] = [rec('r1', 'm1')]): OperationIntent =>
  ({ kind: 'checkpoint', expectedRevision, changeSet: { kind: 'checkpoint', branchId: 'b1', newRecords, metadataPatch: { model: 'm' } } })

describe('InMemorySessionStore commit shell (issue #131)', () => {
  it('checkpoint via prepare→commit persists records and bumps revision', async () => {
    const store = new InMemorySessionStore()
    const r = await store.commit('s1', prepareOperation('s1', ckpt(null)))
    expect(r.revision).toBe(1)
    const page = await store.loadHistory('s1', 'b1')
    expect(page.records).toHaveLength(1)
    expect(page.records[0]).toMatchObject({ recordId: 'r1', messageId: 'm1' })
  })

  it('create-only collision and CAS mismatch throw SessionConflictError', async () => {
    const store = new InMemorySessionStore()
    await store.commit('s1', prepareOperation('s1', ckpt(null)))
    await expect(store.commit('s1', prepareOperation('s1', ckpt(null)))).rejects.toThrow(SessionConflictError)
    await expect(store.commit('s1', prepareOperation('s1', ckpt(5)))).rejects.toThrow(SessionConflictError)
  })

  it('tampered fingerprint is rejected at commit boundary', async () => {
    const store = new InMemorySessionStore()
    const p = prepareOperation('s1', ckpt(null))
    const tampered = { ...p, payload: { ...(p.payload as object), metadataPatch: { model: 'evil' } } }
    await expect(store.commit('s1', tampered as never)).rejects.toThrow(/fingerprint/)
  })

  it('queryOperation returns the stored basic receipt', async () => {
    const store = new InMemorySessionStore()
    const r = await store.commit('s1', prepareOperation('s1', ckpt(null)))
    const q = await store.queryOperation('s1', r.operationId)
    expect(q).toMatchObject({ status: 'committed', receipt: { revision: 1 } })
    expect(await store.queryOperation('s1', 'nope')).toEqual({ status: 'not-committed' })
  })

  it('loadSession exposes state; loadContext assembles segments in order', async () => {
    const store = new InMemorySessionStore()
    await store.commit('s1', prepareOperation('s1', ckpt(null, [rec('r1', 'm1', 'hello')])))
    const state = await store.loadSession('s1')
    expect(state).not.toBeNull()
    expect(state!.revision).toBe(1)
    expect(state!.ownership).toEqual({ rootSessionId: 's1' })
    const msgs = await store.loadContext('s1', 'b1')
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({ id: 'm1', content: 'hello' })
  })

  it('CAS-matched follow-up checkpoint advances revision', async () => {
    const store = new InMemorySessionStore()
    await store.commit('s1', prepareOperation('s1', ckpt(null, [rec('r1', 'm1')])))
    const r2 = await store.commit('s1', prepareOperation('s1', ckpt(1, [rec('r2', 'm2')])))
    expect(r2.revision).toBe(2)
    const page = await store.loadHistory('s1', 'b1')
    expect(page.records.map((x) => x.recordId)).toEqual(['r1', 'r2'])
  })
})

describe('append / revise / todos apply paths (issue #131)', () => {
  async function seeded(store: InMemorySessionStore): Promise<void> {
    await store.commit('s1', prepareOperation('s1', ckpt(null, [rec('r1', 'm1', 'first')])))
  }

  it('append contextAppend:true adds to logs+effective and context tail', async () => {
    const store = new InMemorySessionStore()
    await seeded(store)
    const intent: OperationIntent = {
      kind: 'append', expectedRevision: 1,
      changeSet: { kind: 'append', branchId: 'b1', newRecords: [rec('r2', 'm2', 'second')], contextAppend: true },
    }
    await store.commit('s1', prepareOperation('s1', intent))
    expect((await store.loadHistory('s1', 'b1')).records.map((x) => x.recordId)).toEqual(['r1', 'r2'])
    expect((await store.loadContext('s1', 'b1')).map((m) => m.id)).toEqual(['m1', 'm2'])
  })

  it('append contextAppend:false keeps context unchanged (body only)', async () => {
    const store = new InMemorySessionStore()
    await seeded(store)
    const intent: OperationIntent = {
      kind: 'append', expectedRevision: 1,
      changeSet: { kind: 'append', branchId: 'b1', newRecords: [rec('r2', 'm2', 'side-note')], contextAppend: false },
    }
    await store.commit('s1', prepareOperation('s1', intent))
    expect((await store.loadHistory('s1', 'b1')).records.map((x) => x.recordId)).toEqual(['r1', 'r2'])
    expect((await store.loadContext('s1', 'b1')).map((m) => m.id)).toEqual(['m1'])   // context untouched
  })

  it('revise swaps effective in place and replaces context wholesale; audit view keeps both versions', async () => {
    const store = new InMemorySessionStore()
    await store.commit('s1', prepareOperation('s1', ckpt(null, [rec('r1', 'm1', 'v1'), rec('r2', 'm2', 'keeps')])))
    const intent: OperationIntent = {
      kind: 'revise', expectedRevision: 1,
      changeSet: {
        kind: 'revise', branchId: 'b1', messageId: 'm1',
        newRecord: rec('r3', 'm1', 'v2-corrected'),
        contextUpdate: { segments: [{ kind: 'records', recordIds: ['r3', 'r2'] }] },
      },
    }
    await store.commit('s1', prepareOperation('s1', intent))
    // default view: current versions only
    expect((await store.loadHistory('s1', 'b1')).records.map((x) => x.recordId)).toEqual(['r3', 'r2'])
    // audit view: full log
    const audit = await store.loadHistory('s1', 'b1', { includeSuperseded: true })
    expect(audit.records.map((x) => x.recordId)).toEqual(['r1', 'r2', 'r3'])
    // context replaced wholesale
    expect((await store.loadContext('s1', 'b1')).map((m) => m.content)).toEqual(['v2-corrected', 'keeps'])
  })

  it('saveTodos persists todos without bumping transcript revision (no fake revision)', async () => {
    const store = new InMemorySessionStore()
    await seeded(store)
    const before = (await store.loadSession('s1'))!.revision
    const p = prepareOperation('s1', { kind: 'save-todos', todos: [{ content: 'x', status: 'pending', priority: 'high' }] })
    const r = await store.saveTodos('s1', p)
    expect((r as { revision?: number }).revision).toBeUndefined()   // spec §3.2: not fabricated
    expect(await store.loadTodos('s1')).toEqual([{ content: 'x', status: 'pending', priority: 'high' }])
    expect((await store.loadSession('s1'))!.revision).toBe(before)
  })

  it('saveTodos as first write creates a todo-only session (ownership carried)', async () => {
    const store = new InMemorySessionStore()
    const p = prepareOperation('sub-1', {
      kind: 'save-todos', todos: [],
      ownership: { rootSessionId: 'root-1', parentSessionId: 'root-1' },
    })
    await store.saveTodos('sub-1', p)
    const state = await store.loadSession('sub-1')
    expect(state).not.toBeNull()
    expect(state!.ownership).toEqual({ rootSessionId: 'root-1', parentSessionId: 'root-1' })
    expect(state!.revision).toBe(0)
  })
})
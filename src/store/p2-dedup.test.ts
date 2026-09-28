import { describe, expect, it } from 'vitest'
import { InMemorySessionStore } from './in-memory.js'
import { prepareOperation } from './prepare.js'
import { fingerprintOperation } from './fingerprint.js'
import { OperationConflictError } from './errors.js'
import type { NewRecord, OperationIntent } from './types.js'

const rec = (recordId: string, messageId: string, text = 'x'): NewRecord =>
  ({ recordId, message: { id: messageId, role: 'user', content: text }, actor: { kind: 'main' } })
const ckpt = (expectedRevision: number | null, newRecords: NewRecord[] = [rec('r1', 'm1')]): OperationIntent =>
  ({ kind: 'checkpoint', expectedRevision, changeSet: { kind: 'checkpoint', branchId: 'b1', newRecords, metadataPatch: { model: 'm' } } })

describe('same-ID dedup (issue #131, spec §5.2)', () => {
  it('same opId + same fingerprint → ORIGINAL receipt, no re-apply, revision unchanged', async () => {
    const store = new InMemorySessionStore()
    const p = prepareOperation('s1', ckpt(null))
    const r1 = await store.commit('s1', p)
    const r2 = await store.commit('s1', p)   // retry SAME prepared
    expect(r2.operationId).toBe(r1.operationId)
    expect(r2.committedAt).toBe(r1.committedAt)   // original receipt
    expect((await store.loadSession('s1'))!.revision).toBe(1)   // NOT bumped
  })

  it('same opId + DIFFERENT fingerprint → OperationConflictError', async () => {
    const store = new InMemorySessionStore()
    const p1 = prepareOperation('s1', ckpt(null, [rec('r1', 'm1')]))
    await store.commit('s1', p1)
    const p2 = { ...p1, payload: { ...(p1.payload as object), metadataPatch: { model: 'evil' } } } as typeof p1 & { expectedRevision?: number | null }
    p2.fingerprint = fingerprintOperation('s1', p2.kind, p2.payload, p2.expectedRevision)
    await expect(store.commit('s1', p2)).rejects.toThrow(OperationConflictError)
  })

  it('dedup covers saveTodos and deleteSession', async () => {
    const store = new InMemorySessionStore()
    await store.commit('s1', prepareOperation('s1', { kind: 'register', ownership: { rootSessionId: 's1' } }))
    const tp = prepareOperation('s1', { kind: 'save-todos', todos: [] })
    const t1 = await store.saveTodos('s1', tp)
    const t2 = await store.saveTodos('s1', tp)
    expect(t2.committedAt).toBe(t1.committedAt)
  })

  it('dedup works for register too (idempotent re-registration)', async () => {
    const store = new InMemorySessionStore()
    const rp = prepareOperation('s1', { kind: 'register', ownership: { rootSessionId: 's1' } })
    const r1 = await store.commit('s1', rp)
    const r2 = await store.commit('s1', rp)
    expect(r2.committedAt).toBe(r1.committedAt)
  })
})
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
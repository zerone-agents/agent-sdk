import { describe, expect, it } from 'vitest'
import { InMemorySessionStore } from './in-memory.js'
import { prepareOperation } from './prepare.js'
import { fingerprintOperation } from './fingerprint.js'
import { OperationConflictError } from './errors.js'
import type { NewRecord, OperationIntent } from './types.js'

const rec = (recordId: string, messageId: string, text = 'x'): NewRecord =>
  ({ recordId, message: { id: messageId, role: 'user', content: text }, actor: { kind: 'main' } })
const ckpt = (rev: number | null, r: NewRecord[] = [rec('r1', 'm1')]): OperationIntent =>
  ({ kind: 'checkpoint', expectedRevision: rev, changeSet: { kind: 'checkpoint', branchId: 'b1', newRecords: r, metadataPatch: {} } })

describe('retention — sequence-number watermark (issue #131, spec §5.4)', () => {
  it('receipt past window + watermark NOT advanced → committed (pending unresolved)', async () => {
    const store = new InMemorySessionStore({ receiptRetentionMs: 50 })
    const r = await store.commit('s1', prepareOperation('s1', ckpt(null)))
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect((await store.queryOperation('s1', r.operationId)).status).toBe('committed')
  })

  it('receipt past window + watermark advanced → recycled', async () => {
    const store = new InMemorySessionStore({ receiptRetentionMs: 50 })
    const r = await store.commit('s1', prepareOperation('s1', ckpt(null)))
    await new Promise((resolve) => setTimeout(resolve, 80))
    store.advanceRecyclingWatermark(store.getCommitUpperBound())
    expect(await store.queryOperation('s1', r.operationId)).toEqual({ status: 'recycled' })
  })

  it('watermark past upper bound → throws', async () => {
    const store = new InMemorySessionStore({ receiptRetentionMs: 50 })
    await store.commit('s1', prepareOperation('s1', ckpt(null)))
    expect(() => store.advanceRecyclingWatermark(999)).toThrow(/upper bound/)
  })

  it('advance watermark, then NEW commit past retention → still committed (seq > watermark)', async () => {
    const store = new InMemorySessionStore({ receiptRetentionMs: 50 })
    const r1 = await store.commit('s1', prepareOperation('s1', ckpt(null, [rec('r1', 'm1')])))
    store.advanceRecyclingWatermark(store.getCommitUpperBound())  // watermark = seq of r1
    // New commit AFTER watermark advanced (seq > watermark)
    const r2 = await store.commit('s1', prepareOperation('s1', ckpt(1, [rec('r2', 'm2')])))
    await new Promise((resolve) => setTimeout(resolve, 80))
    // r1: past window AND seq ≤ watermark → recycled
    expect(await store.queryOperation('s1', r1.operationId)).toEqual({ status: 'recycled' })
    // r2: past window BUT seq > watermark → still committed
    expect((await store.queryOperation('s1', r2.operationId)).status).toBe('committed')
  })

  it('no retentionMs → never recycled', async () => {
    const store = new InMemorySessionStore()
    const r = await store.commit('s1', prepareOperation('s1', ckpt(null)))
    store.advanceRecyclingWatermark(store.getCommitUpperBound())
    expect((await store.queryOperation('s1', r.operationId)).status).toBe('committed')
  })

  it('dedup still matches recycled receipts (operation was committed)', async () => {
    const store = new InMemorySessionStore({ receiptRetentionMs: 50 })
    const p = prepareOperation('s1', ckpt(null))
    const r1 = await store.commit('s1', p)
    await new Promise((resolve) => setTimeout(resolve, 80))
    store.advanceRecyclingWatermark(store.getCommitUpperBound())
    const r2 = await store.commit('s1', p)   // dedup
    expect(r2.committedAt).toBe(r1.committedAt)
    expect((await store.loadSession('s1'))!.revision).toBe(1)
  })

  it('queryOperation returns isolated copy: mutating result does not affect dedup', async () => {
    const store = new InMemorySessionStore({ receiptRetentionMs: 50 })
    const p = prepareOperation('s1', ckpt(null))
    const r1 = await store.commit('s1', p)
    // Mutate the query result
    const q = await store.queryOperation('s1', r1.operationId)
    if (q.status === 'committed') {
      q.receipt.fingerprint = 'tampered'
      q.receipt.revision = 999
    }
    // Same prepared retry → STILL returns ORIGINAL receipt
    const r2 = await store.commit('s1', p)
    expect(r2.fingerprint).toBe(r1.fingerprint)
    expect(r2.revision).toBe(r1.revision)
    // Different fingerprint → still rejected (tamper payload, correctly recompute fingerprint)
    const p3 = { ...p, payload: { ...(p.payload as object), metadataPatch: { model: 'evil' } } } as typeof p & { expectedRevision?: number | null }
    p3.fingerprint = fingerprintOperation('s1', p3.kind, p3.payload, p3.expectedRevision)
    await expect(store.commit('s1', p3)).rejects.toThrow(OperationConflictError)
  })
})
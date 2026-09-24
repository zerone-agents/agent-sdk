import { describe, expect, it } from 'vitest'
import { prepareOperation } from './prepare.js'
import { fingerprintOperation } from './fingerprint.js'

const rec = (recordId: string, messageId: string) =>
  ({ recordId, message: { id: messageId, role: 'user' as const, content: 'x' }, actor: { kind: 'main' as const } })
const ckpt = (expectedRevision: number | null) => ({
  kind: 'checkpoint' as const,
  expectedRevision,
  changeSet: { kind: 'checkpoint' as const, branchId: 'b1', newRecords: [rec('r1', 'm1')], metadataPatch: { model: 'm' } },
})

describe('prepareOperation (issue #131, spec §5.1 pure freeze layer)', () => {
  it('freezes operationId/premise/payload and computes a matching fingerprint', () => {
    const p = prepareOperation('s1', ckpt(null))
    expect(p.operationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect((p as { expectedRevision?: number | null }).expectedRevision).toBeNull()
    expect((p.payload as { kind: string }).kind).toBe('checkpoint')
    expect(fingerprintOperation('s1', p.kind, p.payload, (p as { expectedRevision?: number | null }).expectedRevision)).toBe(p.fingerprint)
  })

  it('each call generates a NEW prepared (idempotency = journal reuse, never re-prepare)', () => {
    const a = prepareOperation('s1', ckpt(1))
    const b = prepareOperation('s1', ckpt(1))
    expect(a.operationId).not.toBe(b.operationId)
    expect(a.fingerprint).toBe(b.fingerprint)   // same content, different identity
  })

  it('rejects malformed intents at the boundary (shape guard)', () => {
    expect(() => prepareOperation('s1', { kind: 'checkpoint', changeSet: { kind: 'revise' } } as never)).toThrow(/kind/)
    expect(() => prepareOperation('s1', { kind: 'delete', expectedRevision: 1 } as never)).toThrow(/revision/)
  })

  it('save-todos / delete / register produce premise-free prepared ops', () => {
    const d = prepareOperation('s1', { kind: 'delete', cascadeOwned: true })
    expect(d.kind).toBe('delete')
    expect((d as { expectedRevision?: unknown }).expectedRevision).toBeUndefined()
    const r = prepareOperation('s2', { kind: 'register', ownership: { rootSessionId: 's2' } })
    expect(r.kind).toBe('register')
    expect((r as { expectedRevision?: unknown }).expectedRevision).toBeUndefined()
  })

  it('carries actor and optional auth (execution params excluded from fingerprint)', () => {
    const p1 = prepareOperation('s1', ckpt(1), { actor: { kind: 'subagent', id: 'sub-1' }, auth: { ownerId: 'o', epoch: 3 } })
    const p2 = prepareOperation('s1', ckpt(1))
    expect(p1.actor).toEqual({ kind: 'subagent', id: 'sub-1' })
    expect(p1.fingerprint).toBe(p2.fingerprint)   // actor/auth not fingerprint inputs
  })
})
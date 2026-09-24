import { describe, expect, it } from 'vitest'
import { canonicalJSON, fingerprintOperation } from './fingerprint.js'

const appendCS = (branchId = 'b') => ({ kind: 'append' as const, branchId, newRecords: [] as never[], contextAppend: true })

describe('fingerprint (issue #131, spec §5.3)', () => {
  it('canonicalJSON sorts keys recursively and emits no whitespace', () => {
    expect(canonicalJSON({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}')
  })

  it('is deterministic and key-order independent (payload = ChangeSet itself)', () => {
    const a = fingerprintOperation('s1', 'append', { kind: 'append', branchId: 'b', newRecords: [], contextAppend: true } as never, 2)
    const b = fingerprintOperation('s1', 'append', { contextAppend: true, newRecords: [], kind: 'append', branchId: 'b' } as never, 2)
    expect(a).toBe(b)
  })

  it('auth is not an input (only exclusion — the signature carries no auth parameter)', () => {
    const f = fingerprintOperation as unknown as (...args: unknown[]) => string
    expect(f.length).toBe(4)   // arity: (sessionId, kind, payload, expectedRevision?)
  })

  it('expectedRevision participates (replan => new fingerprint)', () => {
    const cs = appendCS() as never
    expect(fingerprintOperation('s1', 'append', cs, 2)).not.toBe(fingerprintOperation('s1', 'append', cs, 3))
  })

  it('sessionId participates', () => {
    const cs = appendCS() as never
    expect(fingerprintOperation('s1', 'append', cs, 2)).not.toBe(fingerprintOperation('s2', 'append', cs, 2))
  })

  it('premise-free kinds hash without expectedRevision (undefined keys dropped)', () => {
    const p1 = fingerprintOperation('s1', 'delete', { cascadeOwned: true })
    const p2 = fingerprintOperation('s1', 'delete', { cascadeOwned: false })
    expect(p1).not.toBe(p2)
    expect(p1).toMatch(/^[0-9a-f]{64}$/)
  })
})
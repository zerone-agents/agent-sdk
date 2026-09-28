import { describe, expect, it } from 'vitest'
import { InMemorySessionStore } from './in-memory.js'
import { runSessionStoreConformance, createInMemoryP2Context } from './conformance.js'

describe('SessionStore conformance (issue #131, spec §10 p1 group)', () => {
  it('InMemorySessionStore passes the P1 conformance suite', async () => {
    await runSessionStoreConformance(new InMemorySessionStore())
  })
})

describe('SessionStore conformance P2 (issue #131, spec §5/§6)', () => {
  it('InMemorySessionStore passes P1 (no fencing) + P2 (with fencing context)', async () => {
    // P1 compliance: basic operations on a store WITHOUT fencing (backward compat)
    await runSessionStoreConformance(new InMemorySessionStore(), { phases: ['p1'] })
    // P2 compliance: recovery protocol on a store WITH fencing + retention
    const ctx = createInMemoryP2Context(50)
    await runSessionStoreConformance(ctx.store, { phases: ['p2'], p2Context: ctx })
  })

  it('phases:["p2"] without p2Context → rejects (cannot skip core checks)', async () => {
    const store = new InMemorySessionStore()
    await expect(runSessionStoreConformance(store, { phases: ['p2'] })).rejects.toThrow(/p2Context/)
  })
})
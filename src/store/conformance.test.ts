import { describe, expect, it } from 'vitest'
import { InMemorySessionStore } from './in-memory.js'
import { runSessionStoreConformance } from './conformance.js'

describe('SessionStore conformance (issue #131, spec §10 p1 group)', () => {
  it('InMemorySessionStore passes the P1 conformance suite', async () => {
    await runSessionStoreConformance(new InMemorySessionStore())
  })
})
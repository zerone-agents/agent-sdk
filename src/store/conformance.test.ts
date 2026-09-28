import { describe, expect, it } from 'vitest'
import { InMemorySessionStore } from './in-memory.js'
import { runSessionStoreConformance, createInMemoryP2Context } from './conformance.js'
import type { P2TestContext } from './conformance.js'
import type { SessionStore } from './session-store.js'
import type { PreparedOperation } from './types.js'

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

  it('p2Context.store !== store → rejects (cannot test a different implementation)', async () => {
    const targetStore = new InMemorySessionStore()
    const ctx = createInMemoryP2Context(50)   // creates a DIFFERENT store
    await expect(runSessionStoreConformance(targetStore, {
      phases: ['p2'], p2Context: ctx,
    })).rejects.toThrow(/same instance/i)
  })
})

describe('P2 conformance catches broken adapters (issue #131, review R2)', () => {
  /** Wrap a store to break specific entry points — suite must FAIL, not pass silently. */
  function breakEntries(store: SessionStore, breakSaveTodos: boolean, breakDelete: boolean): SessionStore {
    return {
      ...store,
      loadSession: store.loadSession.bind(store),
      loadRecords: store.loadRecords.bind(store),
      loadHistory: store.loadHistory.bind(store),
      loadContext: store.loadContext.bind(store),
      commit: store.commit.bind(store),
      queryOperation: store.queryOperation.bind(store),
      listSessions: store.listSessions?.bind(store),
      loadTodos: store.loadTodos.bind(store),
      saveTodos: breakSaveTodos
        ? async () => { throw new Error('BROKEN saveTodos') }
        : store.saveTodos.bind(store),
      deleteSession: breakDelete
        ? async () => { throw new Error('BROKEN deleteSession') }
        : store.deleteSession.bind(store),
    } as SessionStore
  }

  it('broken saveTodos → P2 suite FAILS (not silently passes)', async () => {
    const ctx = createInMemoryP2Context(50)
    const broken = breakEntries(ctx.store, true, false)
    // Re-wrap context with broken store (same underlying instance identity doesn't matter — we test that the suite catches the break)
    const brokenCtx: P2TestContext = { ...ctx, store: broken }
    await expect(runSessionStoreConformance(broken, {
      phases: ['p2'], p2Context: brokenCtx,
    })).rejects.toThrow()
  })

  it('broken deleteSession → P2 suite FAILS (not silently passes)', async () => {
    const ctx = createInMemoryP2Context(50)
    const broken = breakEntries(ctx.store, false, true)
    const brokenCtx: P2TestContext = { ...ctx, store: broken }
    await expect(runSessionStoreConformance(broken, {
      phases: ['p2'], p2Context: brokenCtx,
    })).rejects.toThrow()
  })
})
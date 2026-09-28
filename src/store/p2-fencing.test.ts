import { describe, expect, it } from 'vitest'
import { InMemorySessionStore } from './in-memory.js'
import { prepareOperation } from './prepare.js'
import { WriteNotAuthorizedError } from './errors.js'
import type { NewRecord, OperationIntent } from './types.js'

const rec = (recordId: string, messageId: string, text = 'x'): NewRecord =>
  ({ recordId, message: { id: messageId, role: 'user', content: text }, actor: { kind: 'main' } })
const ckpt = (expectedRevision: number | null): OperationIntent =>
  ({ kind: 'checkpoint', expectedRevision, changeSet: { kind: 'checkpoint', branchId: 'b1', newRecords: [rec('r1', 'm1')], metadataPatch: {} } })

describe('fencing — three-state mutable authorization (issue #131, spec §6)', () => {
  const authA = { ownerId: 'executor-A', epoch: 1 }
  const authB = { ownerId: 'executor-B', epoch: 2 }

  it('commit with current auth succeeds', async () => {
    const store = new InMemorySessionStore({ fencing: { initialAuth: authA } })
    await store.commit('s1', prepareOperation('s1', ckpt(null), { auth: authA }))
  })

  it('no fencing configured → auth not checked', async () => {
    const store = new InMemorySessionStore()
    await store.commit('s1', prepareOperation('s1', ckpt(null)))   // no auth needed
  })

  it('expired + nobody took over: expireAuthorization → checkpoint/todo/delete ALL rejected', async () => {
    const store = new InMemorySessionStore({ fencing: { initialAuth: authA } })
    await store.commit('s1', prepareOperation('s1', ckpt(null), { auth: authA }))
    store.expireAuthorization()   // lease expired, B has NOT taken over
    // A's old auth is rejected
    await expect(store.commit('s1',
      prepareOperation('s1', ckpt(1), { auth: authA }),
    )).rejects.toThrow(WriteNotAuthorizedError)
    // Even without auth — rejected (fencing enabled, no valid lease)
    await expect(store.commit('s1', prepareOperation('s1', ckpt(1)))).rejects.toThrow(WriteNotAuthorizedError)
    // saveTodos also rejected
    await expect(store.saveTodos('s1',
      prepareOperation('s1', { kind: 'save-todos', todos: [] }, { auth: authA }),
    )).rejects.toThrow(WriteNotAuthorizedError)
    // deleteSession also rejected
    await expect(store.deleteSession('s1',
      prepareOperation('s1', { kind: 'delete' }, { auth: authA }),
    )).rejects.toThrow(WriteNotAuthorizedError)
  })

  it('§6.2 full: A pause→expire→B takeover→A resume→ALL rejected; B works', async () => {
    const store = new InMemorySessionStore({ fencing: { initialAuth: authA } })
    await store.commit('s1', prepareOperation('s1', ckpt(null), { auth: authA }))
    store.expireAuthorization()            // lease expires
    store.refreshAuthorization(authB)      // B takes over
    // A wakes up — ALL rejected
    await expect(store.commit('s1', prepareOperation('s1', ckpt(1), { auth: authA })))
      .rejects.toThrow(WriteNotAuthorizedError)
    await expect(store.saveTodos('s1', prepareOperation('s1', { kind: 'save-todos', todos: [] }, { auth: authA })))
      .rejects.toThrow(WriteNotAuthorizedError)
    // B works (use a different recordId — r1 already exists from A's first commit)
    const r = await store.commit('s1', prepareOperation('s1', {
      kind: 'checkpoint', expectedRevision: 1,
      changeSet: { kind: 'checkpoint', branchId: 'b1', newRecords: [rec('r2', 'm2')], metadataPatch: {} },
    }, { auth: authB }))
    expect(r.revision).toBe(2)
  })

  it('fencing independent from CAS: wrong auth + correct CAS → WriteNotAuthorizedError', async () => {
    const store = new InMemorySessionStore({ fencing: { initialAuth: authA } })
    await store.commit('s1', prepareOperation('s1', ckpt(null), { auth: authA }))
    await expect(store.commit('s1',
      prepareOperation('s1', ckpt(1), { auth: { ownerId: 'wrong', epoch: 99 } }),
    )).rejects.toThrow(WriteNotAuthorizedError)   // NOT SessionConflictError
  })

  it('opts.auth overrides prepared.auth (retry with new authorization)', async () => {
    const store = new InMemorySessionStore({ fencing: { initialAuth: authA } })
    store.refreshAuthorization(authB)   // B takes over BEFORE commit
    const r = await store.commit('s1',
      prepareOperation('s1', ckpt(null), { auth: authA }),   // prepared has OLD auth
      { auth: authB },                                         // opts provides NEW auth — wins
    )
    expect(r.revision).toBe(1)
  })

  it('construction param isolated: mutating initialAuth after construction does not affect store', async () => {
    const initialAuth = { ownerId: 'executor-X', epoch: 1 }
    const store = new InMemorySessionStore({ fencing: { initialAuth } })
    // Mutate the CONSTRUCTION parameter
    initialAuth.ownerId = 'executor-Y'
    initialAuth.epoch = 99
    // Store still expects X/1 (cloned at construction)
    await store.commit('s1', prepareOperation('s1', ckpt(null), { auth: { ownerId: 'executor-X', epoch: 1 } }))
    await expect(store.commit('s1',
      prepareOperation('s1', ckpt(1), { auth: { ownerId: 'executor-Y', epoch: 99 } }),
    )).rejects.toThrow(WriteNotAuthorizedError)
  })

  it('refreshAuthorization param isolated: mutating passed object does not affect store', async () => {
    const store = new InMemorySessionStore({ fencing: { initialAuth: { ownerId: 'A', epoch: 1 } } })
    const newAuth = { ownerId: 'B', epoch: 2 }
    store.refreshAuthorization(newAuth)
    // Mutate the object passed to refreshAuthorization
    newAuth.ownerId = 'A'
    newAuth.epoch = 1
    // Store still expects B/2 (cloned at call time)
    await expect(store.commit('s1',
      prepareOperation('s1', ckpt(null), { auth: { ownerId: 'A', epoch: 1 } }),
    )).rejects.toThrow(WriteNotAuthorizedError)
    // B/2 works
    await store.commit('s1', prepareOperation('s1', ckpt(null), { auth: { ownerId: 'B', epoch: 2 } }))
  })
})
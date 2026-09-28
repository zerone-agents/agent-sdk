import { describe, expect, it } from 'vitest'
import { InMemorySessionStore } from './in-memory.js'
import { prepareOperation } from './prepare.js'
import { OwnershipMismatchError, WriteNotAuthorizedError } from './errors.js'

const selfRegister = (sessionId: string) =>
  prepareOperation(sessionId, { kind: 'register' as const, ownership: { rootSessionId: sessionId } })

describe('register protocol skeleton (issue #131, spec §2.3)', () => {
  it('root self-registration is idempotent: same ownership no-op, no revision, no transcript', async () => {
    const store = new InMemorySessionStore()
    const r1 = await store.commit('root-1', selfRegister('root-1'))
    expect((r1 as { revision?: number }).revision).toBeUndefined()   // register 不推进 revision
    const state1 = await store.loadSession('root-1')
    expect(state1!.ownership).toEqual({ rootSessionId: 'root-1' })
    expect(state1!.branches).toEqual([])                             // no transcript fabricated

    const r2 = await store.commit('root-1', selfRegister('root-1'))
    expect((r2 as { revision?: number }).revision).toBeUndefined()
    expect((await store.loadSession('root-1'))!.revision).toBe(state1!.revision)   // unchanged
  })

  it('re-register with DIFFERENT ownership is rejected (ownership immutable once established)', async () => {
    const store = new InMemorySessionStore()
    await store.commit('root-1', selfRegister('root-1'))
    await expect(store.commit('root-1', prepareOperation('root-1', {
      kind: 'register', ownership: { rootSessionId: 'root-2' },   // trying to swap root — bypass attempt
    }))).rejects.toThrow(OwnershipMismatchError)
  })

  it('child first write succeeds when root is registered (scenario-2 prerequisite at validation layer)', async () => {
    const store = new InMemorySessionStore()
    await store.commit('root-1', selfRegister('root-1'))
    await store.saveTodos('sub-1', prepareOperation('sub-1', {
      kind: 'save-todos', todos: [{ content: 'x', status: 'pending', priority: 'high' }],
      ownership: { rootSessionId: 'root-1', parentSessionId: 'root-1' },
    }))
    expect(await store.loadTodos('sub-1')).toHaveLength(1)
  })

  it('child first write is rejected when root is NOT registered (register before spawn)', async () => {
    const store = new InMemorySessionStore()
    await expect(store.saveTodos('orphan-1', prepareOperation('orphan-1', {
      kind: 'save-todos', todos: [],
      ownership: { rootSessionId: 'never-registered', parentSessionId: 'never-registered' },
    }))).rejects.toThrow(WriteNotAuthorizedError)
    expect(await store.loadSession('orphan-1')).toBeNull()   // no residual row
  })

  it('late register AFTER root deletion is rejected (scenario-3 closure)', async () => {
    const store = new InMemorySessionStore()
    await store.commit('root-1', selfRegister('root-1'))
    await store.deleteSession('root-1', prepareOperation('root-1', { kind: 'delete' }))
    // a spawned-but-unregistered subagent tries to register after root deletion
    await expect(store.commit('sub-late', prepareOperation('sub-late', {
      kind: 'register', ownership: { rootSessionId: 'root-1', parentSessionId: 'root-1' },
    }))).rejects.toThrow(WriteNotAuthorizedError)
    expect(await store.loadSession('sub-late')).toBeNull()
  })
})
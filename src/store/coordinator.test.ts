import { describe, expect, it, vi } from 'vitest'
import { WriteCoordinator, type WriteCoordinatorOptions } from './coordinator.js'
import { NoopJournal, type OperationJournal } from './journal.js'
import { InMemorySessionStore } from './in-memory.js'
import { prepareOperation } from './prepare.js'
import { SessionConflictError, WriteNotAuthorizedError } from './errors.js'
import type { AuthorizationContext, NewRecord, OperationIntent, PreparedOperation } from './types.js'

const rec = (id: string, mid: string): NewRecord =>
  ({ recordId: id, message: { id: mid, role: 'user', content: 'x' }, actor: { kind: 'main' } })

const ckpt = (rev: number | null): OperationIntent => ({
  kind: 'checkpoint', expectedRevision: rev,
  changeSet: { kind: 'checkpoint', branchId: 'b1', newRecords: [rec('r1', 'm1')], metadataPatch: {} },
})

const auth: AuthorizationContext = { ownerId: 'exec-1', epoch: 1 }

describe('WriteCoordinator (issue #131, spec §5/§6)', () => {
  it('execute: prepare → journal.persist → store.commit → journal.release → return receipt', async () => {
    const store = new InMemorySessionStore()
    const journal = { persist: vi.fn(), release: vi.fn() }
    const coord = new WriteCoordinator({ store, journal })
    const receipt = await coord.execute('s1', ckpt(null))
    expect(receipt.revision).toBe(1)
    expect(journal.persist).toHaveBeenCalledTimes(1)
    expect(journal.release).toHaveBeenCalledTimes(1)
  })

  it('save-todos dispatched to store.saveTodos entry', async () => {
    const store = new InMemorySessionStore()
    const journal = { persist: vi.fn(), release: vi.fn() }
    const coord = new WriteCoordinator({ store, journal })
    const r = await coord.execute('s1', { kind: 'save-todos', todos: [] })
    expect(r.kind).toBe('save-todos')
    expect(journal.release).toHaveBeenCalledTimes(1)
  })

  it('delete dispatched to store.deleteSession entry', async () => {
    const store = new InMemorySessionStore()
    await store.commit('s1', prepareOperation('s1', { kind: 'register', ownership: { rootSessionId: 's1' } }))
    const coord = new WriteCoordinator({ store, journal: new NoopJournal() })
    const r = await coord.execute('s1', { kind: 'delete' })
    expect((r.value as { deleted: boolean }).deleted).toBe(true)
  })

  it('register dispatched to store.commit entry', async () => {
    const store = new InMemorySessionStore()
    const coord = new WriteCoordinator({ store, journal: new NoopJournal() })
    const r = await coord.execute('s1', { kind: 'register', ownership: { rootSessionId: 's1' } })
    expect(r.kind).toBe('register')
    expect(r.revision).toBeUndefined()  // register 不推进 revision
  })

  it('fencing auth uniformly injected into all entries', async () => {
    const store = new InMemorySessionStore({ fencing: { initialAuth: auth } })
    const journal = { persist: vi.fn((_p: PreparedOperation) => Promise.resolve()), release: vi.fn(() => Promise.resolve()) }
    const coord = new WriteCoordinator({ store, journal, fencing: { identity: auth } })
    // checkpoint
    await coord.execute('s1', ckpt(null))
    expect(journal.persist.mock.calls[0][0].auth).toEqual(auth)
    // save-todos
    await coord.execute('s1', { kind: 'save-todos', todos: [] })
    expect(journal.persist.mock.calls[1][0].auth).toEqual(auth)
  })

  it('commit success + release failure → return receipt (committed-pending-handoff)', async () => {
    const store = new InMemorySessionStore()
    const failingJournal: OperationJournal = {
      persist: async () => {},
      release: async () => { throw new Error('release journal crash') },
    }
    const coord = new WriteCoordinator({ store, journal: failingJournal })
    const receipt = await coord.execute('s1', ckpt(null))
    expect(receipt.revision).toBe(1)  // commit succeeded — receipt returned
  })

  it('commit explicit failure → throw (release NOT called)', async () => {
    const store = new InMemorySessionStore()
    await store.commit('s1', prepareOperation('s1', ckpt(null)))
    const journal = { persist: vi.fn(), release: vi.fn() }
    const coord = new WriteCoordinator({ store, journal })
    // CAS conflict (revision already 1, trying create-only)
    await expect(coord.execute('s1', ckpt(null))).rejects.toThrow(SessionConflictError)
    expect(journal.release).not.toHaveBeenCalled()
  })

  it('query: committed → original receipt', async () => {
    const store = new InMemorySessionStore()
    const coord = new WriteCoordinator({ store })
    const r = await coord.execute('s1', ckpt(null))
    const q = await coord.query('s1', r.operationId)
    expect(q).not.toBeNull()
    expect(q!.revision).toBe(1)
  })

  it('query: not-committed → null', async () => {
    const store = new InMemorySessionStore()
    const coord = new WriteCoordinator({ store })
    expect(await coord.query('s1', 'never-existed')).toBeNull()
  })

  it('query: recycled → throw (not folded to null)', async () => {
    const store = new InMemorySessionStore({ receiptRetentionMs: 50 })
    const coord = new WriteCoordinator({ store })
    const r = await coord.execute('s1', ckpt(null))
    await new Promise((resolve) => setTimeout(resolve, 80))
    store.advanceRecyclingWatermark(store.getCommitUpperBound())
    await expect(coord.query('s1', r.operationId)).rejects.toThrow(/recycled/i)
  })

  it('retry: same operationId → returns original receipt (no duplicate apply)', async () => {
    const store = new InMemorySessionStore()
    let capturedPrepared!: PreparedOperation
    const journal: OperationJournal = {
      persist: async (p) => { capturedPrepared = p },
      release: async () => {},
    }
    const coord = new WriteCoordinator({ store, journal })
    // First execute — journal captures the original prepared
    const r1 = await coord.execute('s1', ckpt(null))
    expect(capturedPrepared.operationId).toBe(r1.operationId)
    // Retry with the CAPTURED prepared (same operationId + payload + fingerprint)
    const r2 = await coord.retry('s1', capturedPrepared)
    expect(r2.operationId).toBe(r1.operationId)
    expect(r2.committedAt).toBe(r1.committedAt)  // original receipt, not new
    expect((await store.loadSession('s1'))!.revision).toBe(1)  // NOT bumped (dedup)
  })

  it('NoopJournal default mode: works without journal', async () => {
    const store = new InMemorySessionStore()
    const coord = new WriteCoordinator({ store })  // no journal → NoopJournal
    const r = await coord.execute('s1', ckpt(null))
    expect(r.revision).toBe(1)
  })
})
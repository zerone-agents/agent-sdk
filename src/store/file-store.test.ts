import { afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileSessionStore } from './file-store.js'
import { WriteCoordinator, CoordinatorUnknownError } from './coordinator.js'
import { prepareOperation } from './prepare.js'
import { WriteNotAuthorizedError } from './errors.js'
import type { NewRecord } from './types.js'

const rec = (rid: string, mid: string, text: string): NewRecord => ({
  recordId: rid,
  message: { id: mid, role: 'user', content: text },
  actor: { kind: 'main' },
})

const tmpDirs: string[] = []
async function tmpDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'sdk-store-'))
  tmpDirs.push(d)
  return d
}
afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })))
})

const ckpt = (rev: number | null, records: NewRecord[]) => ({
  kind: 'checkpoint' as const,
  expectedRevision: rev,
  changeSet: { kind: 'checkpoint' as const, branchId: 'b1', newRecords: records, metadataPatch: {} },
})

describe('FileSessionStore (issue #131 P3 T7)', () => {
  it('round-trip: commit persists to disk; fresh instance hydrates and reads it', async () => {
    const dir = await tmpDir()
    const a = new FileSessionStore({ dir })
    const coordA = new WriteCoordinator({ store: a })
    await coordA.execute('s1', ckpt(null, [rec('r1', 'm1', 'hello')]))
    // File exists on disk
    const raw = JSON.parse(await readFile(join(dir, 'sessions.json'), 'utf8'))
    expect(raw.sessions.length).toBeGreaterThanOrEqual(1)
    // Fresh instance (separate memory) reads the same session
    const b = new FileSessionStore({ dir })
    const state = await b.loadSession('s1')
    expect(state).not.toBeNull()
    expect(state!.revision).toBe(1)
    const msgs = await b.loadContext('s1', state!.currentBranchId)
    expect((msgs[0] as { content: string }).content).toBe('hello')
  })

  it('receipt dedup survives restart: queryOperation → committed on fresh instance', async () => {
    const dir = await tmpDir()
    const a = new FileSessionStore({ dir })
    const coordA = new WriteCoordinator({ store: a })
    const r = await coordA.execute('s1', ckpt(null, [rec('r1', 'm1', 'x')]))
    const b = new FileSessionStore({ dir })
    const q = await b.queryOperation('s1', r.operationId)
    if (q.status !== 'committed') throw new Error(`expected committed, got ${q.status}`)
    expect(q.receipt.operationId).toBe(r.operationId)
  })

  it('cross-instance writes do not clobber: A commits s1, B commits s2 → both survive', async () => {
    const dir = await tmpDir()
    const a = new FileSessionStore({ dir })
    const coordA = new WriteCoordinator({ store: a })
    await coordA.execute('s1', { kind: 'register', ownership: { rootSessionId: 's1' } })
    await coordA.execute('s1', ckpt(0, [rec('r1', 'm1', 'from-a')]))
    // B: separate instance, same dir — must reload A's write before committing
    const b = new FileSessionStore({ dir })
    const coordB = new WriteCoordinator({ store: b })
    await coordB.execute('s2', ckpt(null, [rec('r2', 'm2', 'from-b')]))
    // Fresh reader sees BOTH sessions
    const c = new FileSessionStore({ dir })
    expect(await c.loadSession('s1')).not.toBeNull()
    expect(await c.loadSession('s2')).not.toBeNull()
  })

  it('tombstone persists: delete → fresh instance → loadSession null', async () => {
    const dir = await tmpDir()
    const a = new FileSessionStore({ dir })
    const coordA = new WriteCoordinator({ store: a })
    await coordA.execute('s1', { kind: 'register', ownership: { rootSessionId: 's1' } })
    await coordA.execute('s1', { kind: 'delete' })
    const b = new FileSessionStore({ dir })
    expect(await b.loadSession('s1')).toBeNull()
  })

  it('todos persist and reload on fresh instance', async () => {
    const dir = await tmpDir()
    const a = new FileSessionStore({ dir })
    const coordA = new WriteCoordinator({ store: a })
    await coordA.execute('s1', ckpt(null, [rec('r1', 'm1', 'x')]))
    await coordA.execute('s1', { kind: 'save-todos', todos: [{ content: 't', status: 'pending', priority: 'high' }] })
    const b = new FileSessionStore({ dir })
    const todos = await b.loadTodos('s1')
    expect(todos).toHaveLength(1)
    expect(todos[0].content).toBe('t')
  })
})

describe('import with todos (issue #131 P3 T7)', () => {
  it('import commits session + todos atomically in one operation', async () => {
    const dir = await tmpDir()
    const store = new FileSessionStore({ dir })
    const coord = new WriteCoordinator({ store })
    const r = await coord.execute('imported', {
      kind: 'import',
      expectedRevision: null,
      changeSet: {
        kind: 'import',
        branchId: 'b1',
        newRecords: [rec('r1', 'm1', 'imported-msg'), rec('r2', 'm2', 'second')],
        effective: ['r1', 'r2'],
        context: { segments: [{ kind: 'records', recordIds: ['r1', 'r2'] }] },
        metadata: {},
        ownership: { rootSessionId: 'imported' },
        todos: [{ content: 'imported-todo', status: 'pending', priority: 'medium' }],
      },
    })
    expect(r.revision).toBe(1)
    const state = await store.loadSession('imported')
    expect(state).not.toBeNull()
    const todos = await store.loadTodos('imported')
    expect(todos).toHaveLength(1)
    expect(todos[0].content).toBe('imported-todo')
    const msgs = await store.loadContext('imported', 'b1')
    expect(msgs).toHaveLength(2)
  })

  it('import without todos → todos empty (backwards compatible)', async () => {
    const dir = await tmpDir()
    const store = new FileSessionStore({ dir })
    const coord = new WriteCoordinator({ store })
    await coord.execute('s-plain', {
      kind: 'import',
      expectedRevision: null,
      changeSet: {
        kind: 'import',
        branchId: 'b1',
        newRecords: [rec('r1', 'm1', 'only-msgs')],
        effective: ['r1'],
        context: { segments: [{ kind: 'records', recordIds: ['r1'] }] },
        metadata: {},
        ownership: { rootSessionId: 's-plain' },
      },
    })
    const todos = await store.loadTodos('s-plain')
    expect(todos).toEqual([])
  })
})

describe('FileSessionStore transactional semantics (review R4-R6)', () => {
  it('review R4: flush failure rolls back memory — no phantom committed receipt', async () => {
    const dir = await tmpDir()
    const store = new FileSessionStore({ dir })
    const coord = new WriteCoordinator({ store })
    // Inject a rename-like failure into the FIRST flush only
    const inner = store as unknown as { flush: () => Promise<void> }
    const originalFlush = inner.flush.bind(store)
    let flushCalls = 0
    inner.flush = async (): Promise<void> => {
      flushCalls++
      if (flushCalls === 1) throw new Error('EIO: rename failed')
      await originalFlush()
    }
    let caught: unknown
    try {
      await coord.execute('s1', ckpt(null, [rec('r1', 'm1', 'hello')]))
    } catch (e) {
      caught = e
    }
    // R7 wiring: unknown outcome carries the original prepared for recovery
    expect(caught).toBeInstanceOf(CoordinatorUnknownError)
    const opId = (caught as CoordinatorUnknownError).prepared.operationId
    // R4: memory rolled back to disk state — query must NOT report committed
    const q = await store.queryOperation('s1', opId)
    expect(q.status).toBe('not-committed')
    // Fresh instance sees nothing either (disk never got the write)
    const b = new FileSessionStore({ dir })
    expect(await b.loadSession('s1')).toBeNull()
  })

  it("review R5: already-hydrated instance A sees instance B's committed writes", async () => {
    const dir = await tmpDir()
    const a = new FileSessionStore({ dir })
    const b = new FileSessionStore({ dir })
    // A reads first (loads the empty disk snapshot into memory)
    expect(await a.loadSession('s1')).toBeNull()
    // B commits + flushes
    const coordB = new WriteCoordinator({ store: b })
    await coordB.execute('s1', ckpt(null, [rec('r1', 'm1', 'from-b')]))
    // A must now see B's write (previously: stale in-memory snapshot → null forever)
    const stateA = await a.loadSession('s1')
    expect(stateA).not.toBeNull()
    expect(stateA!.revision).toBe(1)
  })

  it('review R5: fresh instance reads disk session history via loadHistory', async () => {
    const dir = await tmpDir()
    const a = new FileSessionStore({ dir })
    const coordA = new WriteCoordinator({ store: a })
    await coordA.execute('s1', ckpt(null, [rec('r1', 'm1', 'one'), rec('r2', 'm2', 'two')]))
    const b = new FileSessionStore({ dir })
    const page = await b.loadHistory('s1', 'b1')
    expect(page.records).toHaveLength(2)
  })

  it('review R6: expired authorization persists — writes stay rejected (no resurrection)', async () => {
    const auth = { ownerId: 'exec-1', epoch: 1 }
    const dir = await tmpDir()
    const store = new FileSessionStore({ dir, fencing: { initialAuth: auth } })
    const coord = new WriteCoordinator({ store, fencing: { identity: auth } })
    await coord.execute('s1', ckpt(null, [rec('r1', 'm1', 'x')]))
    await store.expireAuthorization()   // transactional — null persists to disk
    // Same instance: write after expiry rejected (previously: write-reload resurrected disk auth)
    await expect(coord.execute('s1', { kind: 'save-todos', todos: [] })).rejects.toThrow(WriteNotAuthorizedError)
    // Fresh instance: expiry survives construction + read-through reload
    const b = new FileSessionStore({ dir, fencing: { initialAuth: auth } })
    const coordB = new WriteCoordinator({ store: b, fencing: { identity: auth } })
    await b.loadSession('s1')   // force read-through reload (expired state loaded from disk)
    await expect(coordB.execute('s1', { kind: 'save-todos', todos: [] })).rejects.toThrow(WriteNotAuthorizedError)
  })

  it('review R6: refresh on a fresh instance must not wipe existing data', async () => {
    const dir = await tmpDir()
    const a = new FileSessionStore({ dir })
    const coordA = new WriteCoordinator({ store: a })
    await coordA.execute('s1', ckpt(null, [rec('r1', 'm1', 'keep-me')]))
    // Fresh (not-yet-hydrated) instance refreshes auth — previously flushed its
    // EMPTY memory snapshot → wiped A's data off disk
    const b = new FileSessionStore({ dir, fencing: { initialAuth: { ownerId: 'x', epoch: 1 } } })
    await b.refreshAuthorization({ ownerId: 'exec-2', epoch: 2 })
    // Data survives on disk
    const c = new FileSessionStore({ dir })
    expect(await c.loadSession('s1')).not.toBeNull()
  })
})
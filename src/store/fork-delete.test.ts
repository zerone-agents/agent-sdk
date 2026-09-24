import { describe, expect, it } from 'vitest'
import { InMemorySessionStore } from './in-memory.js'
import { prepareOperation } from './prepare.js'
import { planFork } from './plan.js'
import { SessionConflictError, WriteNotAuthorizedError } from './errors.js'
import type { OperationIntent } from './types.js'

const rec = (recordId: string, messageId: string, text: string) =>
  ({ recordId, message: { id: messageId, role: 'user' as const, content: text }, actor: { kind: 'main' as const } })

async function seedSource(store: InMemorySessionStore): Promise<void> {
  const intent: OperationIntent = {
    kind: 'checkpoint', expectedRevision: null,
    changeSet: {
      kind: 'checkpoint', branchId: 'b1',
      newRecords: [rec('r1', 'm1', 'one'), rec('r2', 'm2', 'two')],
      metadataPatch: { model: 'm', cwd: '/w' },
    },
  }
  await store.commit('src-1', prepareOperation('src-1', intent))
}

describe('fork (issue #131, spec §4.4 cross-session transaction)', () => {
  it('planFork reads the source snapshot and commits a create-only target', async () => {
    const store = new InMemorySessionStore()
    await seedSource(store)
    const intent = await planFork(store, { sessionId: 'src-1', branchId: 'b1' }, 'fork-1', { rootSessionId: 'fork-1' })
    expect(intent.kind).toBe('fork')
    expect(intent.expectedRevision).toBeNull()
    const cs = intent.changeSet as { sourceRevision: number; records: string[]; effective: string[] }
    expect(cs.sourceRevision).toBe(1)
    expect(cs.effective).toEqual(['r1', 'r2'])
    const r = await store.commit('fork-1', prepareOperation('fork-1', intent as never))
    expect(r.revision).toBe(1)
    expect(r.sourceRevision).toBe(1)
    // target loads from the shared record store (same-library reference semantics)
    expect((await store.loadHistory('fork-1', 'b1')).records.map((x) => x.recordId)).toEqual(['r1', 'r2'])
    // todos are NOT copied
    expect(await store.loadTodos('fork-1')).toEqual([])
  })

  it('source mutated after prepare → commit rejects on sourceRevision check (not audit-only)', async () => {
    const store = new InMemorySessionStore()
    await seedSource(store)
    const intent = await planFork(store, { sessionId: 'src-1', branchId: 'b1' }, 'fork-2', { rootSessionId: 'fork-2' })
    // source advances AFTER prepare (before fork commit)
    await store.commit('src-1', prepareOperation('src-1', {
      kind: 'append', expectedRevision: 1,
      changeSet: { kind: 'append', branchId: 'b1', newRecords: [rec('r3', 'm3', 'future')], contextAppend: true },
    } as never))
    await expect(store.commit('fork-2', prepareOperation('fork-2', intent as never))).rejects.toThrow(SessionConflictError)
  })

  it('later source evolution does not pollute the fork (records immutable, references stable)', async () => {
    const store = new InMemorySessionStore()
    await seedSource(store)
    const intent = await planFork(store, { sessionId: 'src-1', branchId: 'b1' }, 'fork-3', { rootSessionId: 'fork-3' })
    await store.commit('fork-3', prepareOperation('fork-3', intent as never))
    await store.commit('src-1', prepareOperation('src-1', {
      kind: 'append', expectedRevision: 1,
      changeSet: { kind: 'append', branchId: 'b1', newRecords: [rec('r3', 'm3', 'source-only')], contextAppend: true },
    } as never))
    expect((await store.loadHistory('fork-3', 'b1')).records.map((x) => x.recordId)).toEqual(['r1', 'r2'])
    expect((await store.loadHistory('src-1', 'b1')).records.map((x) => x.recordId)).toEqual(['r1', 'r2', 'r3'])
  })
})

describe('delete tombstone (issue #131, spec §4.6/§6.2)', () => {
  it('deleteSession removes the session (loadSession → null) and cascades owned todo-only children', async () => {
    const store = new InMemorySessionStore()
    await seedSource(store)
    // owned todo-only child
    await store.saveTodos('sub-1', prepareOperation('sub-1', {
      kind: 'save-todos', todos: [{ content: 'x', status: 'pending', priority: 'high' }],
      ownership: { rootSessionId: 'src-1', parentSessionId: 'src-1' },
    }))
    expect(await store.loadSession('sub-1')).not.toBeNull()

    const p = prepareOperation('src-1', { kind: 'delete', cascadeOwned: true })
    const r = await store.deleteSession('src-1', p)
    expect((r.value as { deleted: boolean }).deleted).toBe(true)
    expect(await store.loadSession('src-1')).toBeNull()
    expect(await store.loadSession('sub-1')).toBeNull()          // cascaded (incl. todo-only)
    expect(await store.loadTodos('sub-1')).toEqual([])
  })

  it('late checkpoint after delete is rejected by tombstone (no resurrection)', async () => {
    const store = new InMemorySessionStore()
    await seedSource(store)
    await store.deleteSession('src-1', prepareOperation('src-1', { kind: 'delete' }))
    await expect(store.commit('src-1', prepareOperation('src-1', {
      kind: 'append', expectedRevision: 1,
      changeSet: { kind: 'append', branchId: 'b1', newRecords: [rec('r9', 'm9', 'late')], contextAppend: true },
    } as never))).rejects.toThrow(WriteNotAuthorizedError)
  })

  it('root deleted → late first todo write of an UNREGISTERED child is rejected, no residual row', async () => {
    const store = new InMemorySessionStore()
    await seedSource(store)
    await store.deleteSession('src-1', prepareOperation('src-1', { kind: 'delete', cascadeOwned: true }))
    // a spawned-but-never-written subagent writes its FIRST todo after root deletion
    await expect(store.saveTodos('late-sub', prepareOperation('late-sub', {
      kind: 'save-todos', todos: [],
      ownership: { rootSessionId: 'src-1', parentSessionId: 'src-1' },
    }))).rejects.toThrow(WriteNotAuthorizedError)
    expect(await store.loadSession('late-sub')).toBeNull()       // no residual row
    expect(await store.listSessions()).toEqual([])               // store stays clean
  })
})

describe('import basic path (issue #131, spec §8.3 — full tri-state protocol is P3)', () => {
  it('create-only import builds the target; initialRevision exception sets the starting revision', async () => {
    const store = new InMemorySessionStore()
    const intent = {
      kind: 'import' as const, expectedRevision: null,
      changeSet: {
        kind: 'import' as const, branchId: 'b1',
        newRecords: [rec('r1', 'm1', 'legacy one'), rec('r2', 'm2', 'legacy two')],
        effective: ['r1', 'r2'],
        context: { segments: [{ kind: 'records' as const, recordIds: ['r1', 'r2'] }] },
        metadata: { model: 'legacy-model', cwd: '/legacy' },
        ownership: { rootSessionId: 'imp-1' },
        initialRevision: 7,
      },
    }
    const r = await store.commit('imp-1', prepareOperation('imp-1', intent as never))
    expect(r.revision).toBe(7)   // initialRevision exception: starts at the imported value
    const state = await store.loadSession('imp-1')
    expect(state!.revision).toBe(7)
    expect((await store.loadContext('imp-1', 'b1')).map((m) => m.content)).toEqual(['legacy one', 'legacy two'])
    // follow-up commits increment from the imported value
    const r2 = await store.commit('imp-1', prepareOperation('imp-1', {
      kind: 'append', expectedRevision: 7,
      changeSet: { kind: 'append', branchId: 'b1', newRecords: [rec('r3', 'm3', 'new')], contextAppend: true },
    } as never))
    expect(r2.revision).toBe(8)
  })

  it('import without initialRevision starts at 1 (normal increment)', async () => {
    const store = new InMemorySessionStore()
    const intent = {
      kind: 'import' as const, expectedRevision: null,
      changeSet: {
        kind: 'import' as const, branchId: 'b1', newRecords: [rec('r1', 'm1', 'x')], effective: ['r1'],
        context: { segments: [{ kind: 'records' as const, recordIds: ['r1'] }] },
        metadata: {}, ownership: { rootSessionId: 'imp-2' },
      },
    }
    const r = await store.commit('imp-2', prepareOperation('imp-2', intent as never))
    expect(r.revision).toBe(1)
  })
})
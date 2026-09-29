import { afterAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importLegacySession, importLegacyArchive } from './import.js'
import { InMemorySessionStore } from './in-memory.js'
import { WriteCoordinator } from './coordinator.js'
import { prepareOperation } from './prepare.js'
import type { PreparedOperation } from './types.js'
import type { SessionData, SessionMetadata } from '../session.js'

const tmpDirs: string[] = []
async function tmpDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'sdk-import-'))
  tmpDirs.push(d)
  return d
}
afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })))
})

const legacy = (
  msgs: Array<{ id: string; content: string }>,
  extra?: Partial<SessionMetadata>,
  revision?: number,
): SessionData => ({
  metadata: {
    id: 'legacy-1', cwd: '/legacy/cwd', model: 'm',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    messageCount: msgs.length,
    ...extra,
    ...(revision !== undefined ? { revision } : {}),
  },
  messages: msgs.map((m) => ({ id: m.id, role: 'user' as const, content: m.content })),
})

const rec = (rid: string, mid: string, text: string) => ({
  recordId: rid,
  message: { id: mid, role: 'user' as const, content: text },
  actor: { kind: 'main' as const },
})

describe('importLegacySession (issue #131 P3; review R14/R15 三态协议)', () => {
  it('imports atomically with FULL metadata + legacy todos (R15)', async () => {
    const store = new InMemorySessionStore()
    const report = await importLegacySession({
      store,
      legacyReader: async () => legacy(
        [{ id: 'm1', content: 'hello' }, { id: 'm2', content: 'world' }],
        { provider: 'openai', tag: 'T1', activatedTools: ['Memory', 'MemorySearch'], cwd: '/legacy/cwd' },
        3,
      ),
      legacyTodosReader: async () => [{ content: 'legacy todo', status: 'pending', priority: 'high' }],
    }, 'legacy-1')
    expect(report.status).toBe('imported')
    if (report.status !== 'imported') return
    expect(report.messageCount).toBe(2)
    expect(report.todoCount).toBe(1)
    expect(report.revision).toBe(3)   // initialRevision preserved (§8.3)
    // Full mappable metadata preserved (R15: cwd/provider/tag/activatedTools)
    const state = await store.loadSession('legacy-1')
    expect(state).not.toBeNull()
    expect(state!.metadata.cwd).toBe('/legacy/cwd')
    expect(state!.metadata.provider).toBe('openai')
    expect(state!.metadata.tag).toBe('T1')
    expect(state!.metadata.activatedTools).toEqual(['Memory', 'MemorySearch'])
    // Legacy todos landed atomically with the session
    const todos = await store.loadTodos('legacy-1')
    expect(todos).toHaveLength(1)
    expect(todos[0].content).toBe('legacy todo')
    // Context readable
    const msgs = await store.loadContext('legacy-1', 'b1')
    expect(msgs).toHaveLength(2)
  })

  it('register-only target (row WITHOUT transcript) is NOT skipped — proceeds to import (R14)', async () => {
    const store = new InMemorySessionStore()
    const coord = new WriteCoordinator({ store })
    await coord.execute('legacy-1', { kind: 'register', ownership: { rootSessionId: 'legacy-1' } })
    const report = await importLegacySession({
      store,
      legacyReader: async () => legacy([{ id: 'm1', content: 'x' }]),
    }, 'legacy-1')
    expect(report, JSON.stringify(report)).toMatchObject({ status: 'imported' })
    const msgs = await store.loadContext('legacy-1', 'b1')
    expect(msgs).toHaveLength(1)
  })

  it('transcript-exists target → already-exists-unknown (pending NOT cleared)', async () => {
    const store = new InMemorySessionStore()
    const coord = new WriteCoordinator({ store })
    await coord.execute('legacy-1', {
      kind: 'checkpoint', expectedRevision: null,
      changeSet: { kind: 'checkpoint', branchId: 'b1', newRecords: [rec('r1', 'm1', 'existing')], metadataPatch: {} },
    })
    const report = await importLegacySession({
      store,
      legacyReader: async () => legacy([{ id: 'm1', content: 'x' }]),
    }, 'legacy-1')
    expect(report).toMatchObject({ status: 'already-exists-unknown', existingRevision: 1 })
  })

  it('not-imported when the legacy archive is missing (read failure does not throw)', async () => {
    const store = new InMemorySessionStore()
    const report = await importLegacySession({ store, legacyReader: async () => null }, 'ghost')
    expect(report).toMatchObject({ status: 'not-imported', reason: 'legacy archive not found' })
  })

  it('read errors surface as not-imported reports (batch migration can continue)', async () => {
    const store = new InMemorySessionStore()
    const report = await importLegacySession({ store, legacyReader: async () => { throw new Error('corrupt archive') } }, 'bad')
    expect(report.status).toBe('not-imported')
    if (report.status === 'not-imported') expect(report.reason).toContain('corrupt archive')
  })

  it('unreadable legacy todos → imported report carries a warning (no silent drop)', async () => {
    const store = new InMemorySessionStore()
    const report = await importLegacySession({
      store,
      legacyReader: async () => legacy([{ id: 'm1', content: 'x' }]),
      legacyTodosReader: async () => { throw new Error('todos.json corrupt') },
    }, 'legacy-1')
    expect(report.status).toBe('imported')
    if (report.status !== 'imported') return
    expect(report.warnings?.some((w) => w.includes('todos unreadable'))).toBe(true)
  })

  it('resume: committed original operation → imported without duplicate (R14)', async () => {
    const store = new InMemorySessionStore()
    // First import: capture the original prepared via a journal
    let captured!: PreparedOperation
    const capturingJournal = {
      persist: async (p: PreparedOperation) => { captured = p },
      release: async () => {},
    }
    const coord1 = new WriteCoordinator({ store, journal: capturingJournal })
    const first = await importLegacySession({
      store, coordinator: coord1,
      legacyReader: async () => legacy([{ id: 'm1', content: 'x' }]),
    }, 'legacy-1')
    expect(first.status).toBe('imported')
    // Re-enter with resume = original prepared → queries committed → imported, no duplicate
    const second = await importLegacySession({ store, resume: captured }, 'legacy-1')
    expect(second.status).toBe('imported')
    if (second.status !== 'imported') return
    expect(second.operationId).toBe(captured.operationId)
    const state = await store.loadSession('legacy-1')
    const branch = state!.branches.find((b) => b.branchId === state!.currentBranchId)!
    expect(branch.records).toHaveLength(1)   // no duplicate records
  })

  it('resume: not-committed original → retry with the SAME prepared (no duplicate op)', async () => {
    const store = new InMemorySessionStore()
    const coord = new WriteCoordinator({ store })
    // Build an import prepared WITHOUT committing it (simulates crash-before-commit)
    const prepared = prepareOperation('legacy-1', {
      kind: 'import',
      expectedRevision: null,
      changeSet: {
        kind: 'import',
        branchId: 'b1',
        newRecords: [rec('r1', 'm1', 'from-prepared')],
        effective: ['r1'],
        context: { segments: [{ kind: 'records', recordIds: ['r1'] }] },
        metadata: {},
        ownership: { rootSessionId: 'legacy-1' },
        initialRevision: 0,
      },
    })
    const report = await importLegacySession({ store, coordinator: coord, resume: prepared }, 'legacy-1')
    expect(report.status).toBe('imported')
    if (report.status !== 'imported') return
    expect(report.operationId).toBe(prepared.operationId)   // same operation, not a new one
    const msgs = await store.loadContext('legacy-1', 'b1')
    expect((msgs[0] as { content: string }).content).toBe('from-prepared')
  })

  it('unknown outcome → already-exists-unknown carrying prepared; resume recovers (R14)', async () => {
    const store = new InMemorySessionStore()
    const originalCommit = store.commit.bind(store)
    let calls = 0
    ;(store as unknown as { commit: unknown }).commit = async (
      sid: string,
      prepared: PreparedOperation,
      opts?: unknown,
    ) => {
      calls++
      if (calls === 1) throw new Error('ECONNRESET mid-commit')
      return originalCommit(sid, prepared, opts as never)
    }
    const first = await importLegacySession({
      store,
      legacyReader: async () => legacy([{ id: 'm1', content: 'x' }]),
    }, 'legacy-1')
    expect(first.status).toBe('already-exists-unknown')
    if (first.status !== 'already-exists-unknown') return
    expect(first.prepared).toBeDefined()
    // Resume: query → not-committed → retry the SAME prepared → imported
    const second = await importLegacySession({ store, resume: first.prepared }, 'legacy-1')
    expect(second.status).toBe('imported')
  })
})

describe('importLegacyArchive (review R15)', () => {
  it('scans the archive dir and reports per-session + totals', async () => {
    const dir = await tmpDir()
    await mkdir(join(dir, 'sess-a'), { recursive: true })
    await mkdir(join(dir, 'sess-b'), { recursive: true })
    const store = new InMemorySessionStore()
    const reader = async (sid: string) =>
      (sid === 'sess-a' || sid === 'sess-b' ? legacy([{ id: 'm1', content: sid }]) : null)
    const report = await importLegacyArchive({ store, legacyReader: reader }, { baseDir: dir })
    expect(report.imported).toBe(2)
    expect(report.alreadyExistsUnknown).toBe(0)
    expect(report.notImported).toBe(0)
    expect(report.reports).toHaveLength(2)
  })

  it('missing archive dir → empty aggregate (no throw)', async () => {
    const store = new InMemorySessionStore()
    const report = await importLegacyArchive({ store, legacyReader: async () => null }, { baseDir: '/nonexistent-sdk-archive' })
    expect(report).toMatchObject({ reports: [], imported: 0, alreadyExistsUnknown: 0, notImported: 0 })
  })
})
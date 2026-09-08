import * as fsPromises from 'node:fs/promises'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NodeFileMemoryStorage } from './file-storage.js'
import { MemoryStorageCorruptionError, MemoryStorageLockError } from '../errors.js'
import { MEMORY_JOURNAL_SCHEMA_VERSION, checksumJournalEntry } from './journal.js'
import { createDiagnosticsSink } from '../../utils/diagnostics.js'
import type { MemoryRecord } from '../types.js'

// Builtin ESM namespaces are FROZEN — vi.spyOn(fsPromises, 'appendFile')
// throws "Cannot redefine property". Remount the real module as a mock so the
// namespace is configurable; spies then pass through to real fs after their
// one-shot rejection (mockRejectedValueOnce). Same scaffold as cron's
// lock-faults.test.ts; all other tests in this file use the real functions.
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  return { ...real }
})

let dir: string
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'mem-faults-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

function rec(id: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id, scope: 'global' as const, workspaceId: null, content: `content-${id}`,
    importance: 50 as const, status: 'active' as const, revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null, ...overrides,
  }
}

/** Hand-write a journal line for fixtures (no fsync dependency). */
function line(sequence: number, commit: object): string {
  const payload = { schemaVersion: MEMORY_JOURNAL_SCHEMA_VERSION, sequence, commit }
  return JSON.stringify({ ...payload, checksum: checksumJournalEntry(payload) }) + '\n'
}

describe('NodeFileMemoryStorage fault cases', () => {
  it('second opener on the same directory receives MemoryStorageLockError', async () => {
    const a = new NodeFileMemoryStorage(dir)
    const b = new NodeFileMemoryStorage(dir)
    await a.open()
    await expect(b.open()).rejects.toThrow(MemoryStorageLockError)
    await b.close() // open() failed → no-op, storage stays closed
    await a.close()
  })

  it('torn final line is discarded; records before it survive', async () => {
    await writeFile(path.join(dir, 'journal.jsonl'),
      line(1, { insertRecords: [rec('r1')] }) + '{"schemaVersion":1,"seq')
    const s = new NodeFileMemoryStorage(dir)
    await s.open()
    expect((await s.getRecord('r1'))?.id).toBe('r1')
    await s.close()
  })

  it('non-final corruption fails startup with MemoryStorageCorruptionError', async () => {
    await writeFile(path.join(dir, 'journal.jsonl'), '{"broken":true}\n' + line(2, {}))
    const s = new NodeFileMemoryStorage(dir)
    await expect(s.open()).rejects.toThrow(MemoryStorageCorruptionError)
  })

  it('replay after checkpoint applies only later sequences; at-or-before entries are harmless', async () => {
    await writeFile(path.join(dir, 'state.json'), JSON.stringify({
      schemaVersion: MEMORY_JOURNAL_SCHEMA_VERSION, lastSequence: 2,
      workspaces: [], records: [rec('r1')], audit: [],
    }))
    await writeFile(path.join(dir, 'journal.jsonl'),
      line(2, { insertRecords: [rec('r1', { content: 'must-not-clobber' })] }) + // duplicate of seq 2
      line(3, { insertRecords: [rec('r2')] }))
    const s = new NodeFileMemoryStorage(dir)
    await s.open()
    expect((await s.getRecord('r1'))?.content).toBe('content-r1') // checkpoint copy untouched
    expect((await s.getRecord('r2'))?.id).toBe('r2')
    await s.close()
  })

  it('commit is durable across close + reopen', async () => {
    const a = new NodeFileMemoryStorage(dir)
    await a.open()
    await a.commit({ insertRecords: [rec('durable')] })
    await a.close()
    const b = new NodeFileMemoryStorage(dir)
    await b.open()
    expect((await b.getRecord('durable'))?.id).toBe('durable')
    await b.close()
  })

  it('append failure poisons the storage: later writes reject until reopen (P1-3)', async () => {
    const diagnostics = createDiagnosticsSink()
    const s = new NodeFileMemoryStorage(dir, { diagnostics })
    await s.open()
    await s.commit({ insertRecords: [rec('ok')] })
    const error = new Error('disk gone')
    vi.spyOn(fsPromises, 'appendFile').mockRejectedValueOnce(error)
    await expect(s.commit({ insertRecords: [rec('lost')] })).rejects.toThrow('disk gone')
    // poisoned: every later write rejects with the same error — no sequence
    // reuse hazard, no silent partial-state writes.
    await expect(s.commit({ insertRecords: [rec('never')] })).rejects.toThrow('disk gone')
    await s.close() // skips checkpoint, still releases the lock
    const again = new NodeFileMemoryStorage(dir)
    await again.open() // recovery rebuilds a deterministic state
    expect((await again.getRecord('ok'))?.id).toBe('ok')
    expect(await again.getRecord('lost')).toBeNull()
    await again.close()
  })

  it('a failure between fsync and state swap: poisoned, and reopen recovers the durable row (R2-P1)', async () => {
    const failing = new NodeFileMemoryStorage(dir, {
      beforeSwap: (commit) => {
        if ((commit.insertRecords ?? [])[0]?.id === 'edge') throw new Error('swap exploded')
      },
    })
    await failing.open()
    await failing.commit({ insertRecords: [rec('ok')] })
    // The 'edge' journal row is ALREADY fsync'd when the swap hook throws:
    await expect(failing.commit({ insertRecords: [rec('edge')] })).rejects.toThrow('swap exploded')
    // poisoned: subsequent writes reject — no sequence reuse hazard
    await expect(failing.commit({ insertRecords: [rec('never')] })).rejects.toThrow('swap exploded')
    await failing.close()
    const again = new NodeFileMemoryStorage(dir)
    await again.open() // replay rebuilds the state INCLUDING the durable 'edge' row
    expect((await again.getRecord('edge'))?.id).toBe('edge')
    expect(await again.getRecord('never')).toBeNull()
    await again.close()
  })

  it('checkpoint failure does not fail an already-durable commit; compaction retries (P1-3)', async () => {
    const diagnostics = createDiagnosticsSink()
    const s = new NodeFileMemoryStorage(dir, { checkpointEvery: 1, diagnostics })
    await s.open()
    const warnSpy = vi.spyOn(diagnostics, 'warn')
    vi.spyOn(fsPromises, 'rename').mockRejectedValueOnce(new Error('rename EACCES'))
    // checkpointEvery=1: the FIRST commit triggers a compaction whose rename
    // fails — the commit itself already succeeded and must NOT reject.
    await expect(s.commit({ insertRecords: [rec('durable')] })).resolves.toBeUndefined()
    expect((await s.getRecord('durable'))?.id).toBe('durable')
    expect(warnSpy).toHaveBeenCalled()
    await s.commit({ insertRecords: [rec('second')] }) // compaction retried here
    await s.close()
    const again = new NodeFileMemoryStorage(dir)
    await again.open()
    expect((await again.getRecord('second'))?.id).toBe('second')
    expect((await again.getRecord('durable'))?.id).toBe('durable')
    await again.close()
  })

  it('concurrent commits/ensureWorkspace serialize on one write queue (P1-4)', async () => {
    const s = new NodeFileMemoryStorage(dir)
    await s.open()
    await Promise.all([
      ...Array.from({ length: 20 }, (_, i) => s.commit({ insertRecords: [rec(`r${i}`)] })),
      s.ensureWorkspace({ id: 'ws-x', canonicalPath: '/repo/x' }),
    ])
    // Read the journal BEFORE close() (close compacts it): 20 sequential
    // record lines + 1 workspace envelope = 21 unique monotonic sequences.
    const journal = await readFile(path.join(dir, 'journal.jsonl'), 'utf8')
    const lines = journal.trim().split('\n')
    expect(lines).toHaveLength(21)
    expect(lines.map((l) => JSON.parse(l).sequence)).toEqual(
      Array.from({ length: 21 }, (_, i) => i + 1))
    await s.close()
    const again = new NodeFileMemoryStorage(dir)
    await again.open()
    expect((await again.getRecord('r0'))?.id).toBe('r0')
    expect((await again.getRecord('r19'))?.id).toBe('r19')
    await again.close()
  })

  it('data files and directories are owner-only on supported platforms', async () => {
    const s = new NodeFileMemoryStorage(dir)
    await s.open()
    await s.commit({ insertRecords: [rec('modes')] })
    const dirMode = (await stat(dir)).mode & 0o777
    const fileMode = (await stat(path.join(dir, 'journal.jsonl'))).mode & 0o777
    await s.close() // state.json is only written by compaction — close() (or the 50th commit)
    const checkpointMode = (await stat(path.join(dir, 'state.json'))).mode & 0o777
    expect(dirMode & 0o077).toBe(0) // umask may widen, but never group/other bits
    expect(fileMode & 0o077).toBe(0)
    expect(checkpointMode & 0o077).toBe(0)
  })

  it('purged content disappears from checkpoint and journal after compaction', async () => {
    const s = new NodeFileMemoryStorage(dir)
    await s.open()
    await s.commit({ insertRecords: [rec('victim', { content: 'SENSITIVE_DO_NOT_PERSIST' })] })
    await s.commit({ deleteRecords: ['victim'] })
    await s.close() // close() checkpoints + truncates the journal (compaction)
    const checkpoint = await readFile(path.join(dir, 'state.json'), 'utf8')
    const journal = await readFile(path.join(dir, 'journal.jsonl'), 'utf8')
    expect(checkpoint).not.toContain('SENSITIVE_DO_NOT_PERSIST')
    expect(journal).not.toContain('SENSITIVE_DO_NOT_PERSIST')
  })

  it('a complete final line with a bad checksum fails open() — never silently discarded (P1-2)', async () => {
    const payload = { schemaVersion: MEMORY_JOURNAL_SCHEMA_VERSION, sequence: 1, commit: {} }
    await writeFile(path.join(dir, 'journal.jsonl'),
      JSON.stringify({ ...payload, checksum: '0'.repeat(64) }) + '\n')
    const s = new NodeFileMemoryStorage(dir)
    await expect(s.open()).rejects.toThrow(MemoryStorageCorruptionError)
  })

  it('sequence gap fails startup', async () => {
    await writeFile(path.join(dir, 'journal.jsonl'), line(1, {}) + line(3, {}))
    const s = new NodeFileMemoryStorage(dir)
    await expect(s.open()).rejects.toThrow(/sequence/i)
  })

  it('unsupported schema version fails startup', async () => {
    const future = { schemaVersion: 999, sequence: 1, commit: {} }
    await writeFile(path.join(dir, 'journal.jsonl'),
      JSON.stringify({ ...future, checksum: checksumJournalEntry(future) }) + '\n')
    const s = new NodeFileMemoryStorage(dir)
    await expect(s.open()).rejects.toThrow(/schema/i)
  })
})
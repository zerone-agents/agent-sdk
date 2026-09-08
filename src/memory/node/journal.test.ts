import { mkdtemp, readFile, rm, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MEMORY_JOURNAL_SCHEMA_VERSION,
  appendJournalEntry,
  checksumJournalEntry,
  emptyMemoryState,
  loadMemoryState,
  writeMemoryCheckpoint,
} from './journal.js'
import { MemoryStorageCorruptionError } from '../errors.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'mem-journal-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

function entry(sequence: number, commit = {}): string {
  const payload = { schemaVersion: MEMORY_JOURNAL_SCHEMA_VERSION, sequence, commit }
  return JSON.stringify({ ...payload, checksum: checksumJournalEntry(payload) })
}

describe('journal IO', () => {
  it('empty dir → empty state', async () => {
    expect(await loadMemoryState(dir)).toEqual(emptyMemoryState())
  })

  it('appends + fsyncs entries and replays past the checkpoint', async () => {
    const record = {
      id: 'r1', scope: 'global' as const, workspaceId: null, content: 'replayed',
      importance: 50 as const, status: 'active' as const, revision: 1,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      deletedAt: null,
    }
    await writeMemoryCheckpoint(dir, { ...emptyMemoryState(), lastSequence: 1 })
    await appendJournalEntry(dir, JSON.parse(entry(2, { insertRecords: [record] })))
    const loaded = await loadMemoryState(dir)
    expect(loaded.lastSequence).toBe(2)
    expect(loaded.records).toEqual([record])
  })

  it('a torn final line (no trailing \\n) is discarded AND truncated; later appends stay clean', async () => {
    await writeFile(path.join(dir, 'journal.jsonl'), `${entry(1)}\n{"schemaVersion":1,"seque`)
    expect((await loadMemoryState(dir)).lastSequence).toBe(1)
    // Recovery must TRUNCATE the invalid tail (review P1-2): a second load
    // must succeed on a clean file, and appends continue normally.
    expect((await loadMemoryState(dir)).lastSequence).toBe(1)
    await appendJournalEntry(dir, JSON.parse(entry(2)))
    expect((await loadMemoryState(dir)).lastSequence).toBe(2)
  })

  it('a complete final line with a bad checksum is CORRUPTION, not torn (review P1-2)', async () => {
    // Complete line (trailing \n), all fields valid, checksum wrong — this is
    // what a bit-flip on an already-fsynced, CONFIRMED commit looks like. It
    // must fail startup, never be silently discarded.
    const payload = { schemaVersion: MEMORY_JOURNAL_SCHEMA_VERSION, sequence: 1, commit: {} }
    await writeFile(path.join(dir, 'journal.jsonl'),
      JSON.stringify({ ...payload, checksum: '0'.repeat(64) }) + '\n')
    await expect(loadMemoryState(dir)).rejects.toThrow(MemoryStorageCorruptionError)
  })

  it('a corrupt middle line fails startup', async () => {
    // Fresh dir per test → the journal never exists here; force makes this a
    // belt-and-braces no-op (verbatim rm without force would ENOENT).
    await rm(path.join(dir, 'journal.jsonl'), { force: true })
    await writeFile(path.join(dir, 'journal.jsonl'), `{"broken":true}\n${entry(2)}\n`)
    await expect(loadMemoryState(dir)).rejects.toThrow(MemoryStorageCorruptionError)
  })

  it('sequence gaps and unsupported schema versions fail startup', async () => {
    await writeFile(path.join(dir, 'journal.jsonl'), `${entry(1)}\n${entry(3)}\n`)
    await expect(loadMemoryState(dir)).rejects.toThrow(/sequence/i)

    await rm(path.join(dir, 'journal.jsonl'))
    const future = { schemaVersion: 999, sequence: 1, commit: {} }
    await writeFile(path.join(dir, 'journal.jsonl'),
      JSON.stringify({ ...future, checksum: checksumJournalEntry(future) }) + '\n')
    await expect(loadMemoryState(dir)).rejects.toThrow(/schema/i)
  })
})
import { createHash } from 'node:crypto'
import { appendFile, open, readFile, rename, truncate, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { DiagnosticsSink } from '../../utils/diagnostics.js'
import type { MemoryStorageCommit } from '../storage.js'
import type { MemoryAuditEvent, MemoryRecord, MemoryWorkspace } from '../types.js'
import { MemoryStorageCorruptionError } from '../errors.js'

export const MEMORY_JOURNAL_SCHEMA_VERSION = 1

export interface MemoryCheckpointState {
  schemaVersion: number
  lastSequence: number
  workspaces: MemoryWorkspace[]
  records: MemoryRecord[]
  audit: MemoryAuditEvent[]
}

export function emptyMemoryState(): MemoryCheckpointState {
  return { schemaVersion: MEMORY_JOURNAL_SCHEMA_VERSION, lastSequence: 0, workspaces: [], records: [], audit: [] }
}

export interface JournalEntry {
  schemaVersion: number
  sequence: number
  commit: MemoryStorageCommit
  checksum: string
}

/** sha256 hex of the canonical JSON of { schemaVersion, sequence, commit }. */
export function checksumJournalEntry(payload: { schemaVersion: number; sequence: number; commit: MemoryStorageCommit }): string {
  return createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex')
}

function corruption(message: string, cause?: unknown): MemoryStorageCorruptionError {
  return cause === undefined
    ? new MemoryStorageCorruptionError(message)
    : new MemoryStorageCorruptionError(message, { cause })
}

/**
 * Diagnostics that MUST NEVER THROW (R4-P1): a throwing host sink here could
 * turn torn-tail recovery into a startup failure. Raw errors travel via the
 * cause channel, never interpolated into the message.
 */
function safeWarn(sink: DiagnosticsSink | undefined, msg: string, cause?: unknown): void {
  if (sink === undefined) return
  try {
    sink.warn(msg, undefined, cause)
  } catch {
    // diagnostics must never affect storage behavior
  }
}

/**
 * Apply ONE journal commit to the current checkpoint-shaped state (pure
 * copy-on-write, mirroring buildNextState semantics: write-time copies, delete
 * wins over insert for the same id, replace keeps the original position,
 * audit redaction/delete/append). Returns a NEW state object — the caller
 * swaps it in with the entry's sequence.
 */
function applyCommit(
  state: MemoryCheckpointState,
  sequence: number,
  commit: MemoryStorageCommit,
): MemoryCheckpointState {
  const records = new Map(state.records.map((r) => [r.id, r]))
  const workspaces = new Map(state.workspaces.map((w) => [w.id, w]))
  let audit = [...state.audit]
  for (const r of commit.insertRecords ?? []) records.set(r.id, { ...r })
  for (const r of commit.replaceRecords ?? []) records.set(r.id, { ...r })
  for (const id of commit.deleteRecords ?? []) records.delete(id)
  for (const w of commit.ensureWorkspaces ?? []) workspaces.set(w.id, { ...w })
  const redact = new Set(commit.redactAuditForRecords ?? [])
  if (redact.size > 0) {
    audit = audit.map((e) => (redact.has(e.recordId) ? { ...e, beforeContent: null, afterContent: null } : e))
  }
  const deleteIds = new Set(commit.deleteAuditIds ?? [])
  if (deleteIds.size > 0) audit = audit.filter((e) => !deleteIds.has(e.id))
  audit.push(...(commit.appendAudit ?? []).map((e) => ({ ...e })))
  return {
    schemaVersion: state.schemaVersion,
    lastSequence: sequence,
    workspaces: Array.from(workspaces.values()),
    records: Array.from(records.values()),
    audit,
  }
}

/**
 * Load the merged checkpoint + journal state. state.json missing → empty
 * state; journal.jsonl missing → checkpoint state as-is. Parses and validates
 * every line: checksum, schemaVersion, and sequence continuity from
 * lastSequence+1 (entries at or before the checkpoint sequence are skipped
 * harmlessly — duplicate/old replay).
 *
 * Final-line rule (review P1-2): the last non-empty line WITHOUT a trailing
 * '\n' is a torn write (crash mid-append) → DISCARD it AND physically truncate
 * the file to the previous line boundary (without the truncation the next
 * startup would classify the old torn line as a corrupt MIDDLE line and never
 * recover), plus a diagnostics warn. A last line that DOES end with '\n' but
 * fails parse/checksum is a complete-envelope corruption — it may be a
 * confirmed, already-fsynced commit — startup fails with
 * MemoryStorageCorruptionError, NEVER silently discarded. Corruption anywhere
 * else, a sequence gap, or an unsupported schemaVersion → the same startup
 * error.
 */
export async function loadMemoryState(
  memoryDir: string,
  diagnostics?: DiagnosticsSink,
): Promise<MemoryCheckpointState> {
  const statePath = path.join(memoryDir, 'state.json')
  const journalPath = path.join(memoryDir, 'journal.jsonl')

  let state: MemoryCheckpointState
  try {
    const raw = await readFile(statePath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<MemoryCheckpointState> & { schemaVersion?: unknown }
    if (parsed.schemaVersion !== MEMORY_JOURNAL_SCHEMA_VERSION) {
      throw corruption(
        `Memory checkpoint state.json has unsupported schemaVersion ${JSON.stringify(parsed.schemaVersion)} (expected ${MEMORY_JOURNAL_SCHEMA_VERSION})`,
      )
    }
    state = {
      schemaVersion: MEMORY_JOURNAL_SCHEMA_VERSION,
      lastSequence: parsed.lastSequence ?? 0,
      workspaces: parsed.workspaces ?? [],
      records: parsed.records ?? [],
      audit: parsed.audit ?? [],
    }
  } catch (err) {
    if (err instanceof MemoryStorageCorruptionError) throw err
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      state = emptyMemoryState() // missing checkpoint = fresh storage
    } else {
      throw corruption('Memory checkpoint state.json is corrupted and cannot be parsed', err)
    }
  }

  let raw: string
  try {
    raw = await readFile(journalPath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return state // no journal → nothing to replay
    throw err
  }
  if (raw.length === 0) return state

  let content = raw
  if (!raw.endsWith('\n')) {
    // Torn final line (crash mid-append): byte-precise trim to the previous
    // line boundary (raw is utf8; lastIndexOf('\n') + 1 is exact). The
    // truncation is REQUIRED (P1-2): without it the torn bytes stay in the
    // file and the next startup sees them as a corrupt middle line.
    const tornStart = raw.lastIndexOf('\n') + 1
    const cleanPrefix = raw.slice(0, tornStart)
    safeWarn(diagnostics, '[memory] journal ended mid-line (torn write); trailing bytes discarded and file truncated')
    await truncate(journalPath, Buffer.byteLength(cleanPrefix, 'utf8'))
    content = cleanPrefix
  }

  const lines = content.split('\n')
  let expected = state.lastSequence + 1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.length === 0) continue // trailing empty element from the final '\n' (or a fully truncated file)
    const lineNo = i + 1
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (err) {
      throw corruption(`Memory journal.jsonl line ${lineNo} is not valid JSON`, err)
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw corruption(`Memory journal.jsonl line ${lineNo} is not an envelope object`)
    }
    const entry = parsed as Partial<JournalEntry>
    if (entry.schemaVersion !== MEMORY_JOURNAL_SCHEMA_VERSION) {
      throw corruption(
        `Memory journal.jsonl line ${lineNo} has unsupported schemaVersion ${JSON.stringify(entry.schemaVersion)} (expected ${MEMORY_JOURNAL_SCHEMA_VERSION})`,
      )
    }
    const payload = { schemaVersion: entry.schemaVersion, sequence: entry.sequence!, commit: entry.commit! }
    if (typeof entry.checksum !== 'string' || entry.checksum !== checksumJournalEntry(payload)) {
      throw corruption(`Memory journal.jsonl line ${lineNo} checksum mismatch — the envelope may have been altered or truncated`)
    }
    if (entry.sequence! <= state.lastSequence) continue // at-or-before the checkpoint: harmless replay skip
    if (entry.sequence! !== expected) {
      throw corruption(
        `Memory journal.jsonl line ${lineNo} sequence gap: expected ${expected}, got ${entry.sequence}`,
      )
    }
    state = applyCommit(state, entry.sequence!, entry.commit!)
    expected = state.lastSequence + 1
  }
  return state
}

/**
 * Append ONE complete journal envelope as a single JSONL line, then fsync the
 * file (reopen 'r+' + sync). TOP-LEVEL fs/promises.appendFile — faults tests
 * spy on this exact symbol for injectable failures (review P1-3); if the
 * implementation API changes, update the mock targets there (mock-drift
 * lesson).
 */
export async function appendJournalEntry(memoryDir: string, entry: JournalEntry): Promise<void> {
  const journalPath = path.join(memoryDir, 'journal.jsonl')
  await appendFile(journalPath, JSON.stringify(entry) + '\n', { mode: 0o600 })
  const handle = await open(journalPath, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * Checkpoint rewrite: write state.json.tmp (mode 0o600) → file fsync →
 * atomic rename over state.json → best-effort dir fsync (unsupported on some
 * platforms → tolerated). The journal is truncated separately by the caller
 * (compaction = checkpoint first, then journal trim).
 */
export async function writeMemoryCheckpoint(memoryDir: string, state: MemoryCheckpointState): Promise<void> {
  const statePath = path.join(memoryDir, 'state.json')
  const tmpPath = `${statePath}.tmp`
  const handle = await open(tmpPath, 'w', 0o600)
  try {
    await handle.writeFile(JSON.stringify(state), 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(tmpPath, statePath)
  try {
    const dirHandle = await open(memoryDir, 'r')
    try {
      await dirHandle.sync()
    } finally {
      await dirHandle.close()
    }
  } catch (err) {
    // Round-6 review (P1): ONLY tolerate explicit "unsupported" platform
    // errors — some filesystems reject directory fsync with EINVAL/ENOTSUP
    // (and Windows directory opens with EISDIR). A REAL I/O failure
    // (EIO/EACCES/ENOSPC/…) must propagate: the rename above is not yet
    // guaranteed durable, so proceeding to truncate the journal here could
    // lose CONFIRMED commits on a crash. Propagating keeps the caller's
    // checkpoint error path active — journal retained, compaction retried.
    const code = (err as NodeJS.ErrnoException | null)?.code
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EISDIR') throw err
  }
}
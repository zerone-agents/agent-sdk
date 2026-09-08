import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { stableErrorType, type DiagnosticsSink } from '../../utils/diagnostics.js'
import type {
  MemoryStorage,
  MemoryStorageAuditQuery,
  MemoryStorageCommit,
  MemoryStorageRecordQuery,
} from '../storage.js'
import type { MemoryAuditEvent, MemoryRecord, MemoryWorkspace } from '../types.js'
import { acquireMemoryLock, type MemoryLock } from './lock.js'
import {
  MEMORY_JOURNAL_SCHEMA_VERSION,
  appendJournalEntry,
  checksumJournalEntry,
  emptyMemoryState,
  loadMemoryState,
  writeMemoryCheckpoint,
  type MemoryCheckpointState,
} from './journal.js'

export interface NodeFileMemoryStorageOptions {
  checkpointEvery?: number
  diagnostics?: DiagnosticsSink
  /** Test seam (R2-P1): runs after fsync, before the state swap; throwing simulates a swap-path failure whose durable row must survive via open() replay. */
  beforeSwap?: (commit: MemoryStorageCommit) => void
}

/** Fully prepared next state: the complete checkpoint state PLUS its indexes (R3-P1/R4-P2). Declared at MODULE level — TypeScript does not allow interfaces inside a class body (round-5 review R5-P2). */
interface MemoryPreparedState {
  state: MemoryCheckpointState
  recordIndex: Map<string, MemoryRecord>
  workspaceIndex: Map<string, MemoryWorkspace>
}

/** Node journal-backed storage over a single-writer lock (issue #61). */
export class NodeFileMemoryStorage implements MemoryStorage {
  private state: MemoryCheckpointState = emptyMemoryState()
  private recordIndex = new Map<string, MemoryRecord>()   // built from state on open
  private workspaceIndex = new Map<string, MemoryWorkspace>()
  private lock: MemoryLock | null = null
  private isOpen = false
  private commitsSinceCheckpoint = 0
  private poisonedError: unknown = null

  constructor(
    private readonly memoryDir: string,
    private readonly options: NodeFileMemoryStorageOptions = {},
  ) {}

  async open(): Promise<void> {
    if (this.isOpen) throw new Error('NodeFileMemoryStorage.open called on an open storage')
    this.lock = await acquireMemoryLock(this.memoryDir)
    try {
      this.state = await loadMemoryState(this.memoryDir, this.options.diagnostics)
      this.rebuildIndexes()
      this.poisonedError = null // fresh recovery path (review P1-3): open() IS the recovery
      this.isOpen = true
    } catch (err) {
      await this.lock.release().catch(() => {})
      this.lock = null
      throw err
    }
  }

  // One shared write queue (review P1-4): commit and ensureWorkspace serialize
  // through the SAME chain so sequence allocation, journal append and in-memory
  // apply are atomic per operation (no concurrent duplicate sequences).
  private writeChain: Promise<unknown> = Promise.resolve()
  private poison(err: unknown): void {
    if (this.poisonedError !== null) return
    this.poisonedError = err
    // R4-P1: all diagnostics go through safeError — a throwing host sink must
    // never corrupt storage failure semantics (R3-P1) or escape this path.
    this.safeError(
      '[memory] journal append/fsync failed; storage is failure-closed until close()+open()',
      { errorType: stableErrorType(err) },
      err instanceof Error ? err : new Error(String(err)),
    )
  }

  /**
   * Diagnostics that MUST NEVER THROW (R4-P1): a host sink throwing here could
   * reject an already-durable commit (tryCheckpoint) or skip the lock release
   * (close poisoned path). Every post-commit diagnostics call goes through
   * these; raw errors travel via the cause channel, never interpolated into
   * the message.
   */
  private safeWarn(msg: string, fields?: Record<string, unknown>, cause?: unknown): void {
    try {
      this.options.diagnostics?.warn(msg, fields, cause)
    } catch {
      // diagnostics must never affect storage behavior (R3-P1/R4-P1)
    }
  }

  private safeError(msg: string, fields?: Record<string, unknown>, cause?: unknown): void {
    try {
      this.options.diagnostics?.error(msg, fields, cause)
    } catch {
      // diagnostics must never affect storage behavior (R3-P1/R4-P1)
    }
  }
  private assertNotPoisoned(method: string): void {
    if (this.poisonedError !== null) throw this.poisonedError
  }
  private serializeWrite<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(fn)
    this.writeChain = run.then(() => undefined, () => undefined)
    return run
  }
  /** Journal-append + fsync + atomic state swap, WITHOUT the write queue. */
  private async writeOnce(commit: MemoryStorageCommit): Promise<void> {
    this.assertNotPoisoned('commit')
    const sequence = this.state.lastSequence + 1
    // ROUND-2 REVIEW (R2-P1): build the COMPLETE next state in memory FIRST
    // (copy-build, pure map/array ops — no I/O, no partial state), and after
    // the durable append perform ONLY reference swaps (cannot throw). Any
    // failure BEFORE the swap — build or fsync — poisons the storage, so no
    // sequence is reused and the fsync'd row is recovered by open() replay.
    let next: MemoryPreparedState
    try {
      next = this.buildNextState(commit) // pure in-memory build
    } catch (err) {
      this.poison(err) // state could be half-built → fail closed (R2-P1)
      throw err
    }
    const payload = { schemaVersion: MEMORY_JOURNAL_SCHEMA_VERSION, sequence, commit }
    const entry = { ...payload, checksum: checksumJournalEntry(payload) }
    try {
      await appendJournalEntry(this.memoryDir, entry) // durable BEFORE the swap
    } catch (err) {
      this.poison(err) // durability outcome unknown → stop writing (review P1-3)
      throw err
    }
    // Test seam (R2-P1 / R3-P1): throwing here simulates a failure between fsync
    // and swap. The journal row IS durable, so the failure MUST poison: the
    // in-memory state and sequence intentionally did NOT follow the journal —
    // continuing would reuse the sequence, and close() would checkpoint the
    // STALE state and truncate the journal, losing the fsync'd row. Poisoned
    // close() skips the checkpoint (journal stays intact) and open() replay
    // recovers the row. Relationship to "fsync = success" (spec §8): the
    // DURABLE data is never discarded; the caller sees a failure because this
    // process's state cannot safely track it — the recovery path is precise.
    try {
      if (this.options.beforeSwap) this.options.beforeSwap(commit)
    } catch (err) {
      this.poison(err)
      throw err
    }
    this.swapState(next, sequence) // reference replacement — cannot throw (R2-P1)
    if (++this.commitsSinceCheckpoint >= (this.options.checkpointEvery ?? 50)) {
      await this.tryCheckpoint() // failure → diagnostics only; commit already succeeded
    }
  }

  /** Copy-build the full next state AND its indexes (pure memory; replaced applyCommit, R2-P1/R3-P1). */
  private buildNextState(commit: MemoryStorageCommit): MemoryPreparedState {
    const records = new Map(this.state.records.map((r) => [r.id, r]))
    const workspaces = new Map(this.state.workspaces.map((w) => [w.id, w]))
    let audit = [...this.state.audit]
    const redact = new Set(commit.redactAuditForRecords ?? [])
    const deleteIds = new Set(commit.deleteAuditIds ?? [])
    // Write-time copies (R4-P2): see InMemoryMemoryStorage.commit — ownership
    // isolation holds for the Node adapter too.
    for (const r of commit.insertRecords ?? []) records.set(r.id, { ...r })
    for (const r of commit.replaceRecords ?? []) records.set(r.id, { ...r })
    for (const id of commit.deleteRecords ?? []) records.delete(id)
    for (const w of commit.ensureWorkspaces ?? []) workspaces.set(w.id, { ...w }) // write-time copy (R4-P2)
    if (redact.size > 0) {
      audit = audit.map((e) => (redact.has(e.recordId) ? { ...e, beforeContent: null, afterContent: null } : e))
    }
    if (deleteIds.size > 0) audit = audit.filter((e) => !deleteIds.has(e.id))
    audit.push(...(commit.appendAudit ?? []).map((e) => ({ ...e }))) // write-time copy (R4-P2)
    // Indexes are ALSO built here (R3-P1): everything fallible happens before
    // the durable append, so swapState() can be a pure reference assignment.
    const recordIndex = new Map<string, MemoryRecord>()
    for (const r of records.values()) recordIndex.set(r.id, r)
    const workspaceIndex = new Map(workspaces)
    return {
      state: {
        schemaVersion: MEMORY_JOURNAL_SCHEMA_VERSION,
        lastSequence: this.state.lastSequence,
        workspaces: Array.from(workspaces.values()),
        records: Array.from(records.values()),
        audit,
      },
      recordIndex,
      workspaceIndex,
    }
  }

  /** Atomic swap — pure reference assignment; cannot fail (R2-P1/R3-P1). */
  private swapState(
    next: MemoryPreparedState,
    sequence: number,
  ): void {
    this.state = { ...next.state, lastSequence: sequence }
    this.recordIndex = next.recordIndex
    this.workspaceIndex = next.workspaceIndex
  }

  async commit(commit: MemoryStorageCommit): Promise<void> {
    this.assertOpen('commit')
    return this.serializeWrite(() => this.writeOnce(commit))
  }

  async ensureWorkspace(workspace: MemoryWorkspace): Promise<void> {
    this.assertOpen('ensureWorkspace')
    return this.serializeWrite(async () => {
      if (this.workspaceIndex.has(workspace.id)) return // idempotent
      await this.writeOnce({ ensureWorkspaces: [workspace] })
    })
  }

  async close(): Promise<void> {
    if (!this.isOpen) return
    if (this.poisonedError !== null) {
      // review P1-3: cannot checkpoint deterministically; open() recovery path
      // rebuilds state from the journal next start. safeWarn (R4-P1): a
      // throwing sink must NOT skip the lock release below.
      this.safeWarn('[memory] skipping checkpoint on poisoned storage; recovery runs at next open()')
    } else {
      await this.tryCheckpoint() // includes journal truncation
    }
    this.isOpen = false
    await this.lock?.release()
    this.lock = null
  }

  private async tryCheckpoint(): Promise<void> {
    try {
      await writeMemoryCheckpoint(this.memoryDir, this.state)
      // compact: truncate journal (entries <= lastSequence replay harmlessly anyway)
      await writeFile(path.join(this.memoryDir, 'journal.jsonl'), '', { mode: 0o600 })
      this.commitsSinceCheckpoint = 0
    } catch (err) {
      // review P1-3 + R4-P1: compaction is post-commit bookkeeping — report
      // and retry on the next commit/close; the commit itself was already
      // durable. safeWarn never throws: a throwing host sink must not turn an
      // already-successful commit into a rejected one. The raw error goes via
      // the cause channel, never interpolated into the message.
      this.safeWarn(
        '[memory] checkpoint/compaction skipped, retried later',
        { errorType: stableErrorType(err) },
        err,
      )
    }
  }

  private rebuildIndexes(): void {
    this.recordIndex = new Map(this.state.records.map((r) => [r.id, r]))
    this.workspaceIndex = new Map(this.state.workspaces.map((w) => [w.id, w]))
  }

  private assertOpen(method: string): void {
    if (!this.isOpen) throw new Error(`NodeFileMemoryStorage.${method} called outside open lifecycle`)
  }

  async *scanWorkspaces(): AsyncIterable<MemoryWorkspace> {
    this.assertOpen('scanWorkspaces')
    for (const ws of this.workspaceIndex.values()) yield { ...ws } // read snapshot (R4-P2)
  }

  async getRecord(recordId: string): Promise<MemoryRecord | null> {
    this.assertOpen('getRecord')
    const record = this.recordIndex.get(recordId)
    return record ? { ...record } : null // read snapshot (R4-P2)
  }

  async *scanRecords(query: MemoryStorageRecordQuery): AsyncIterable<MemoryRecord> {
    this.assertOpen('scanRecords')
    for (const record of this.recordIndex.values()) {
      if (query.scope !== undefined && record.scope !== query.scope) continue
      if (query.workspaceId !== undefined && record.workspaceId !== query.workspaceId) continue
      if (query.statuses && !query.statuses.includes(record.status)) continue
      yield { ...record } // read snapshot (R4-P2)
    }
  }

  async *scanAudit(query: MemoryStorageAuditQuery): AsyncIterable<MemoryAuditEvent> {
    this.assertOpen('scanAudit')
    let events = this.state.audit
    if (query.recordId !== undefined) events = events.filter((e) => e.recordId === query.recordId)
    if (query.limit !== undefined) events = events.slice(0, query.limit)
    for (const e of events) yield { ...e } // read snapshot (R4-P2)
  }
}
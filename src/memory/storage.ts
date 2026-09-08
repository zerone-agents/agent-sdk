import type { MemoryAuditEvent, MemoryRecord, MemoryScope, MemoryStatus, MemoryWorkspace } from './types.js'

export interface MemoryStorageRecordQuery {
  scope?: MemoryScope
  workspaceId?: string | null
  statuses?: MemoryStatus[]
}

export interface MemoryStorageAuditQuery {
  recordId?: string
  limit?: number
}

/**
 * One atomic commit. The SERVICE computes the full effect (including capacity
 * archives, audit appends, redactions and retention deletions); storage only
 * persists it. All-or-nothing and durable before resolution.
 */
export interface MemoryStorageCommit {
  insertRecords?: MemoryRecord[]
  /** Full-record replacement matched by id. */
  replaceRecords?: MemoryRecord[]
  /** Hard delete by id — purge only; soft delete is a replace with status. */
  deleteRecords?: string[]
  appendAudit?: MemoryAuditEvent[]
  /** Null out before/after content on every audit event for these record IDs. */
  redactAuditForRecords?: string[]
  /** Retention: delete these audit event IDs. */
  deleteAuditIds?: string[]
  /** Workspace registrations to persist (Node adapter journal path; wired in Task 13). */
  ensureWorkspaces?: MemoryWorkspace[]
}

/**
 * Port: persistence operations only — NO domain rules (no budgets, no state
 * machine, no search ranking). Direct storage mutation outside MemoryService
 * is unsupported.
 *
 * Lifecycle contract: `open()` must be called before any other method and
 * `close()` before process exit; both are idempotent-ish (double open/close
 * does not corrupt state). Methods called while CLOSED reject with an Error
 * whose message contains BOTH the method name AND the word "open" (e.g.
 * `NodeFileMemoryStorage.getRecord called outside open lifecycle`) — hosts
 * and tests may rely on the method name for attribution and on the "open"
 * marker for lifecycle-classification.
 *
 * Scan determinism contract: `scanRecords`/`scanWorkspaces`/`scanAudit` yield
 * in INSERTION ORDER — the order in which records/workspaces/audit events
 * were first written (a replace keeps the original position; a delete removes
 * the slot; later inserts append). The order survives `close()` + `open()`:
 * the Node adapter preserves it by replaying the journal in sequence order
 * and checkpointing state arrays in that same order.
 */
export interface MemoryStorage {
  open(): Promise<void>
  close(): Promise<void>
  /** Idempotent durable registration; NOT a record mutation, no audit event. */
  ensureWorkspace(workspace: MemoryWorkspace): Promise<void>
  scanWorkspaces(): AsyncIterable<MemoryWorkspace>
  getRecord(recordId: string): Promise<MemoryRecord | null>
  scanRecords(query: MemoryStorageRecordQuery): AsyncIterable<MemoryRecord>
  commit(commit: MemoryStorageCommit): Promise<void>
  scanAudit(query: MemoryStorageAuditQuery): AsyncIterable<MemoryAuditEvent>
}
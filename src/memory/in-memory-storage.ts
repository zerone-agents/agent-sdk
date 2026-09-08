import type { MemoryStorage, MemoryStorageAuditQuery, MemoryStorageCommit, MemoryStorageRecordQuery } from './storage.js'
import type { MemoryAuditEvent, MemoryRecord, MemoryWorkspace } from './types.js'

export interface InMemoryMemoryStorageOptions {
  /** Test seam: throwing here simulates a commit failure BEFORE any apply. */
  beforeCommit?: (commit: MemoryStorageCommit) => void
}

/** SDK test adapter. Commits apply via copy-then-swap for all-or-nothing. */
export class InMemoryMemoryStorage implements MemoryStorage {
  private records = new Map<string, MemoryRecord>()
  private workspaces = new Map<string, MemoryWorkspace>()
  private audit: MemoryAuditEvent[] = []
  private isOpen = false
  private pendingFailure: Error | null = null

  constructor(private readonly options: InMemoryMemoryStorageOptions = {}) {}

  /** Test helper: the next commit() rejects before applying anything. */
  failNextCommit(error: Error): void {
    this.pendingFailure = error
  }

  private assertOpen(method: string): void {
    if (!this.isOpen) throw new Error(`InMemoryMemoryStorage.${method} called outside open lifecycle`)
  }

  async open(): Promise<void> { this.isOpen = true }
  async close(): Promise<void> { this.isOpen = false }

  async ensureWorkspace(workspace: MemoryWorkspace): Promise<void> {
    this.assertOpen('ensureWorkspace')
    // Write-time copy (R4-P2): later mutations of the caller's object must not
    // corrupt the registered workspace.
    if (!this.workspaces.has(workspace.id)) this.workspaces.set(workspace.id, { ...workspace })
  }

  async *scanWorkspaces(): AsyncIterable<MemoryWorkspace> {
    this.assertOpen('scanWorkspaces')
    for (const ws of this.workspaces.values()) yield { ...ws } // read snapshot (R4-P2)
  }

  async getRecord(recordId: string): Promise<MemoryRecord | null> {
    this.assertOpen('getRecord')
    const record = this.records.get(recordId)
    return record ? { ...record } : null // read snapshot (R4-P2)
  }

  async *scanRecords(query: MemoryStorageRecordQuery): AsyncIterable<MemoryRecord> {
    this.assertOpen('scanRecords')
    for (const record of this.records.values()) {
      if (query.scope !== undefined && record.scope !== query.scope) continue
      if (query.workspaceId !== undefined && record.workspaceId !== query.workspaceId) continue
      if (query.statuses && !query.statuses.includes(record.status)) continue
      yield { ...record } // read snapshot (R4-P2)
    }
  }

  async commit(commit: MemoryStorageCommit): Promise<void> {
    this.assertOpen('commit')
    this.options.beforeCommit?.(commit)
    if (this.pendingFailure) {
      const err = this.pendingFailure
      this.pendingFailure = null
      throw err
    }
    // Copy-then-swap: apply to clones; swap only when every op succeeded.
    const records = new Map(this.records)
    let audit = [...this.audit]
    // Write-time copies (R4-P2): every record/audit entering the store is
    // COPIED — later mutation of the caller's objects cannot alter stored
    // state (flat structures → spread copies are full ownership isolation).
    for (const r of commit.insertRecords ?? []) records.set(r.id, { ...r })
    for (const r of commit.replaceRecords ?? []) records.set(r.id, { ...r })
    for (const id of commit.deleteRecords ?? []) records.delete(id)
    const redact = new Set(commit.redactAuditForRecords ?? [])
    if (redact.size > 0) {
      audit = audit.map((e) => redact.has(e.recordId) ? { ...e, beforeContent: null, afterContent: null } : e)
    }
    const deleteIds = new Set(commit.deleteAuditIds ?? [])
    if (deleteIds.size > 0) audit = audit.filter((e) => !deleteIds.has(e.id))
    audit.push(...(commit.appendAudit ?? []).map((e) => ({ ...e }))) // write-time copy (R4-P2)
    this.records = records
    this.audit = audit
  }

  async *scanAudit(query: MemoryStorageAuditQuery): AsyncIterable<MemoryAuditEvent> {
    this.assertOpen('scanAudit')
    let events = this.audit
    if (query.recordId !== undefined) events = events.filter((e) => e.recordId === query.recordId)
    if (query.limit !== undefined) events = events.slice(0, query.limit)
    for (const e of events) yield { ...e } // read snapshot (R4-P2)
  }
}
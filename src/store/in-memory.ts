/**
 * InMemorySessionStore —— v4 参考实现（issue #131）。
 * 真 CAS / tombstone / 回执语义；conformance 套件的依据实现（App 对照实现 SQLite adapter）。
 * P1 边界：queryOperation 返回基础回执（同 ID 去重/重试状态机/fencing 校验/保留窗口为 P2）。
 */
import type { NormalizedMessageParam } from '../providers/types.js'
import type { TodoInfo } from '../types.js'
import type {
  AuthorizationContext,
  HistoryPage,
  HistoryQuery,
  MessageRecord,
  OperationLookup,
  OperationReceipt,
  PreparedOperation,
  SessionState,
} from './types.js'
import { SessionConflictError, SessionDataInvalidError, WriteNotAuthorizedError } from './errors.js'
import { applyChangeSet, initialStoreData, type StoreData } from './apply.js'
import { fingerprintOperation } from './fingerprint.js'
import type { CommitEntryOpts, OwnershipFilter, SessionStore } from './session-store.js'

const TRANSCRIPT_KINDS: ReadonlySet<string> = new Set(['checkpoint', 'compact', 'rollback', 'branch-switch', 'append', 'revise', 'fork', 'import'])

interface SessionRow {
  data: StoreData
  tombstone?: { deletedAt: string }
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionRow>()
  private readonly receipts = new Map<string, OperationReceipt>()

  // ── 读取 ───────────────────────────────────────────────

  async loadSession(sessionId: string): Promise<SessionState | null> {
    const row = this.sessions.get(sessionId)
    if (!row || row.tombstone) return null
    return structuredClone(row.data.state)
  }

  async loadRecords(sessionId: string, recordIds: string[]): Promise<(MessageRecord | null)[]> {
    const row = this.sessions.get(sessionId)
    if (!row || row.tombstone) return recordIds.map(() => null)
    return recordIds.map((id) => row.data.records.get(id) ?? null)
  }

  async loadHistory(sessionId: string, branchId: string, opts?: HistoryQuery): Promise<HistoryPage> {
    const row = this.requireRow(sessionId)
    const branch = row.data.state.branches.find((b) => b.branchId === branchId)
    if (!branch) throw new SessionDataInvalidError(sessionId, `unknown branch: ${branchId}`)
    const ordered = opts?.includeSuperseded ? branch.records : branch.effective
    const offset = opts?.cursor ? Number(opts.cursor) : 0
    const limit = opts?.limit ?? ordered.length
    const slice = ordered.slice(offset, offset + limit)
    const records = slice.map((id) => {
      const r = row.data.records.get(id)
      if (!r) throw new SessionDataInvalidError(sessionId, `unknown record id in branch: ${id}`)
      return r
    })
    const nextCursor = offset + limit < ordered.length ? String(offset + limit) : undefined
    return { records, nextCursor }
  }

  async loadContext(sessionId: string, branchId: string): Promise<NormalizedMessageParam[]> {
    const row = this.requireRow(sessionId)
    const branch = row.data.state.branches.find((b) => b.branchId === branchId)
    if (!branch) throw new SessionDataInvalidError(sessionId, `unknown branch: ${branchId}`)
    const out: NormalizedMessageParam[] = []
    for (const seg of branch.context.segments) {
      const ids = seg.kind === 'records' ? seg.recordIds : [seg.summaryRecordId]
      for (const id of ids) {
        const r = row.data.records.get(id)
        if (!r) throw new SessionDataInvalidError(sessionId, `unknown record id in context: ${id}`)
        out.push(r.message)
      }
    }
    return out
  }

  async listSessions(filter?: OwnershipFilter): Promise<SessionState['metadata'][]> {
    const out: SessionState['metadata'][] = []
    for (const row of this.sessions.values()) {
      if (row.tombstone) continue
      const o = row.data.state.ownership
      if (filter?.rootSessionId && o.rootSessionId !== filter.rootSessionId) continue
      if (filter?.parentSessionId && o.parentSessionId !== filter.parentSessionId) continue
      out.push(structuredClone(row.data.state.metadata))
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async loadTodos(sessionId: string): Promise<TodoInfo[]> {
    const row = this.sessions.get(sessionId)
    if (!row || row.tombstone) return []
    return structuredClone(row.data.todos)
  }

  // ── 提交 ───────────────────────────────────────────────

  async commit(sessionId: string, prepared: PreparedOperation, opts?: CommitEntryOpts): Promise<OperationReceipt> {
    this.verifyFingerprint(sessionId, prepared)
    if (!TRANSCRIPT_KINDS.has(prepared.kind)) {
      // save-todos / delete / register 走各自提交入口（saveTodos / deleteSession / commit-register）
      throw new SessionDataInvalidError(sessionId, `kind "${prepared.kind}" must go through its dedicated entry`)
    }
    const now = new Date().toISOString()
    const row = this.requireWritable(sessionId)
    this.checkCas(sessionId, row, prepared)

    if (prepared.kind === 'checkpoint' || prepared.kind === 'compact' || prepared.kind === 'rollback'
      || prepared.kind === 'branch-switch' || prepared.kind === 'append' || prepared.kind === 'revise') {
      applyChangeSet(sessionId, row.data, prepared.payload as never, { committedAt: now })
      row.data.state.revision += 1
      row.data.state.updatedAt = now
      return this.recordReceipt(prepared, { revision: row.data.state.revision, committedAt: now, auth: opts?.auth })
    }
    // fork / import：T8 实现（跨 session / initialRevision）
    throw new Error(`commit: kind "${prepared.kind}" not implemented in P1 slice yet`)
  }

  async saveTodos(sessionId: string, prepared: PreparedOperation, opts?: CommitEntryOpts): Promise<OperationReceipt> {
    this.verifyFingerprint(sessionId, prepared)
    if (prepared.kind !== 'save-todos') throw new SessionDataInvalidError(sessionId, 'saveTodos expects kind "save-todos"')
    // T5 实现（todos 落库；revision 不变）
    throw new Error('saveTodos: not implemented in P1 slice yet')
  }

  async deleteSession(sessionId: string, prepared: PreparedOperation, opts?: CommitEntryOpts): Promise<OperationReceipt> {
    this.verifyFingerprint(sessionId, prepared)
    if (prepared.kind !== 'delete') throw new SessionDataInvalidError(sessionId, 'deleteSession expects kind "delete"')
    // T8 实现（tombstone + cascadeOwned）
    throw new Error('deleteSession: not implemented in P1 slice yet')
  }

  async queryOperation(sessionId: string, operationId: string): Promise<OperationLookup> {
    const receipt = this.receipts.get(`${sessionId}:${operationId}`)
    return receipt ? { status: 'committed', receipt } : { status: 'not-committed' }
  }

  // ── 内部 ───────────────────────────────────────────────

  /** 供 register（T9）与内部使用：登记/写入前的事务化校验入口。 */
  ensureRow(sessionId: string, ownership?: { rootSessionId: string; parentSessionId?: string; parentToolUseId?: string }): SessionRow {
    let row = this.sessions.get(sessionId)
    if (row?.tombstone) {
      throw new WriteNotAuthorizedError(`session ${sessionId} is deleted (tombstone)`)
    }
    if (!row) {
      const now = new Date().toISOString()
      row = { data: initialStoreData(sessionId, ownership ?? { rootSessionId: sessionId }, now) }
      this.sessions.set(sessionId, row)
    }
    return row
  }

  private requireRow(sessionId: string): SessionRow {
    const row = this.sessions.get(sessionId)
    if (!row || row.tombstone) throw new SessionDataInvalidError(sessionId, 'session not found')
    return row
  }

  private requireWritable(sessionId: string): SessionRow {
    const row = this.sessions.get(sessionId)
    if (row?.tombstone) {
      throw new WriteNotAuthorizedError(`session ${sessionId} is deleted (tombstone)`)
    }
    if (!row) {
      // create-only 首写：由 CAS 分支保证 expectedRevision === null 才允许到达这里
      return this.ensureRow(sessionId)
    }
    return row
  }

  private checkCas(sessionId: string, row: SessionRow | undefined, prepared: PreparedOperation): void {
    const premise = (prepared as { expectedRevision?: number | null }).expectedRevision
    if (premise === undefined) return // premise-free kinds（不经 commit 的 transcript 路径）
    if (premise === null) {
      if (row && !row.tombstone && row.data.state.revision > 0) {
        throw new SessionConflictError(sessionId, null, row.data.state.revision)
      }
      return
    }
    if (!row || row.tombstone) {
      throw new SessionConflictError(sessionId, premise, undefined)
    }
    const actual = row.data.state.revision
    if (actual !== premise) {
      throw new SessionConflictError(sessionId, premise, actual)
    }
  }

  private verifyFingerprint(sessionId: string, prepared: PreparedOperation): void {
    const expected = fingerprintOperation(
      sessionId,
      prepared.kind,
      prepared.payload as never,
      (prepared as { expectedRevision?: number | null }).expectedRevision,
    )
    if (expected !== prepared.fingerprint) {
      throw new SessionDataInvalidError(sessionId, 'fingerprint mismatch: prepared payload tampered')
    }
  }

  private recordReceipt(
    prepared: PreparedOperation,
    out: { revision?: number; committedAt: string; auth?: AuthorizationContext },
  ): OperationReceipt {
    const receipt: OperationReceipt = {
      operationId: prepared.operationId,
      fingerprint: prepared.fingerprint,
      kind: prepared.kind,
      sessionId: prepared.sessionId,
      actor: structuredClone(prepared.actor),
      committedAt: out.committedAt,
      ...(out.revision !== undefined ? { revision: out.revision } : {}),
    }
    this.receipts.set(`${prepared.sessionId}:${prepared.operationId}`, receipt)
    return structuredClone(receipt)
  }
}
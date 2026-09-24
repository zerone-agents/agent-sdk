/**
 * InMemorySessionStore —— v4 参考实现（issue #131）。
 * 真 CAS / tombstone / 回执语义；conformance 套件的依据实现（App 对照实现 SQLite adapter）。
 * P1 边界：queryOperation 返回基础回执（同 ID 去重/重试状态机/fencing 校验/保留窗口为 P2）。
 */
import type { NormalizedMessageParam } from '../providers/types.js'
import type { TodoInfo } from '../types.js'
import type {
  AuthorizationContext,
  CommitValue,
  HistoryPage,
  HistoryQuery,
  MessageRecord,
  OperationLookup,
  OperationReceipt,
  PreparedOperation,
  SessionState,
} from './types.js'
import { OwnershipMismatchError, SessionConflictError, SessionDataInvalidError, WriteNotAuthorizedError } from './errors.js'
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
  /** 同库共享记录表（recordId 全局唯一；fork「引用」语义的基础——spec §4.4）。 */
  private readonly records = new Map<string, MessageRecord>()
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
    if (prepared.kind === 'register') {
      return this.commitRegister(sessionId, prepared, opts)
    }
    if (!TRANSCRIPT_KINDS.has(prepared.kind)) {
      // save-todos / delete 走各自提交入口（saveTodos / deleteSession）
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
    if (prepared.kind === 'fork' || prepared.kind === 'import') {
      const changeSet = prepared.payload as ChangeSetLike
      if (prepared.kind === 'fork') {
        // 源快照冻结校验（spec §4.4）：源必须存在且 revision == 冻结值——不是审计
        const srcState = await this.loadSession(changeSet.source!.sessionId)
        if (!srcState || srcState.revision !== changeSet.sourceRevision) {
          throw new SessionConflictError(sessionId, null, srcState?.revision)
        }
      }
      applyChangeSet(sessionId, row.data, changeSet as never, { committedAt: now })
      // import 的 initialRevision 例外（spec §8.3）：起点 = 导入值；否则正常递增
      if (prepared.kind === 'import' && changeSet.initialRevision !== undefined) {
        row.data.state.revision = changeSet.initialRevision
      } else {
        row.data.state.revision += 1
      }
      row.data.state.updatedAt = now
      return this.recordReceipt(prepared, {
        revision: row.data.state.revision,
        committedAt: now,
        auth: opts?.auth,
        ...(prepared.kind === 'fork' ? { sourceRevision: changeSet.sourceRevision } : {}),
      })
    }
    throw new SessionDataInvalidError(sessionId, `unsupported transcript kind: ${prepared.kind}`)
  }

  async saveTodos(sessionId: string, prepared: PreparedOperation, opts?: CommitEntryOpts): Promise<OperationReceipt> {
    this.verifyFingerprint(sessionId, prepared)
    if (prepared.kind !== 'save-todos') throw new SessionDataInvalidError(sessionId, 'saveTodos expects kind "save-todos"')
    const payload = prepared.payload as {
      todos: TodoInfo[]
      ownership?: { rootSessionId: string; parentSessionId?: string; parentToolUseId?: string }
    }
    // tombstone 拒绝（迟到写入）；首写创建 todo-only session 行（ownership 随 payload）
    const row = this.ensureRow(sessionId, payload.ownership)
    row.data.todos = structuredClone(payload.todos)
    const now = new Date().toISOString()
    row.data.state.updatedAt = now
    // spec §3.2/§4.7：todos 不推进 transcript revision——回执不伪造 revision
    return this.recordReceipt(prepared, { committedAt: now, auth: opts?.auth })
  }

  async deleteSession(sessionId: string, prepared: PreparedOperation, opts?: CommitEntryOpts): Promise<OperationReceipt> {
    this.verifyFingerprint(sessionId, prepared)
    if (prepared.kind !== 'delete') throw new SessionDataInvalidError(sessionId, 'deleteSession expects kind "delete"')
    const now = new Date().toISOString()
    const row = this.sessions.get(sessionId)
    // 幂等：不存在 / 已删除 → deleted:false（同 ID 凭据去重为 P2）
    if (!row || row.tombstone) {
      return this.recordReceipt(prepared, { committedAt: now, auth: opts?.auth, value: { deleted: false } })
    }
    const cascade = (prepared.payload as { cascadeOwned?: boolean }).cascadeOwned === true
    row.tombstone = { deletedAt: now }
    if (cascade) {
      // 级联清理全部 owned session（含 todo-only；按 ownership.rootSessionId 匹配——spec §2.3）
      for (const [sid, r] of this.sessions) {
        if (sid === sessionId || r.tombstone) continue
        if (r.data.state.ownership.rootSessionId === sessionId) {
          r.tombstone = { deletedAt: now }
        }
      }
    }
    return this.recordReceipt(prepared, { committedAt: now, auth: opts?.auth, value: { deleted: true } })
  }

  async queryOperation(sessionId: string, operationId: string): Promise<OperationLookup> {
    const receipt = this.receipts.get(`${sessionId}:${operationId}`)
    return receipt ? { status: 'committed', receipt } : { status: 'not-committed' }
  }

  // ── 内部 ───────────────────────────────────────────────

  /** register 提交（spec §2.3 登记协议）：幂等、无 revision、不产生 transcript。 */
  private async commitRegister(sessionId: string, prepared: PreparedOperation, opts?: CommitEntryOpts): Promise<OperationReceipt> {
    const ownership = (prepared.payload as { ownership: { rootSessionId: string; parentSessionId?: string; parentToolUseId?: string } }).ownership
    const existing = this.sessions.get(sessionId)
    if (existing?.tombstone) {
      throw new WriteNotAuthorizedError(`session ${sessionId} is deleted (tombstone)`)
    }
    const now = new Date().toISOString()
    if (existing) {
      // 幂等：同归属 no-op；归属确立后不可变更（不得换 root 绕过级联隔离）
      if (!sameOwnership(existing.data.state.ownership, ownership)) {
        throw new OwnershipMismatchError(`session ${sessionId} already registered with a different ownership`)
      }
      return this.recordReceipt(prepared, { committedAt: now, auth: opts?.auth })
    }
    // 新登记：归属链校验（root/parent 已登记且无 tombstone；自指跳过）在 ensureRow 内
    this.ensureRow(sessionId, ownership)
    return this.recordReceipt(prepared, { committedAt: now, auth: opts?.auth })   // 无 revision
  }

  /** 供 register（T9）与内部使用：登记/写入前的事务化校验入口。 */
  ensureRow(sessionId: string, ownership?: { rootSessionId: string; parentSessionId?: string; parentToolUseId?: string }): SessionRow {
    // 归属存续校验（spec §6.2）：root/parent 已存在的行必须无 tombstone。
    // （P1 T8：不存在者先放行——T9 register 协议收紧为「必须已登记」。）
    if (ownership) {
      for (const pid of [ownership.rootSessionId, ownership.parentSessionId]) {
        if (!pid || pid === sessionId) continue
        const p = this.sessions.get(pid)
        if (!p || p.tombstone) {
          throw new WriteNotAuthorizedError(`ownership target ${pid} is not registered or deleted (register protocol, spec §2.3)`)
        }
      }
    }
    let row = this.sessions.get(sessionId)
    if (row?.tombstone) {
      throw new WriteNotAuthorizedError(`session ${sessionId} is deleted (tombstone)`)
    }
    if (!row) {
      const now = new Date().toISOString()
      row = { data: initialStoreData(sessionId, ownership ?? { rootSessionId: sessionId }, now) }
      row.data.records = this.records   // 共享全局记录表（同库引用语义）
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
    out: { revision?: number; committedAt: string; auth?: AuthorizationContext; value?: CommitValue; sourceRevision?: number },
  ): OperationReceipt {
    const receipt: OperationReceipt = {
      operationId: prepared.operationId,
      fingerprint: prepared.fingerprint,
      kind: prepared.kind,
      sessionId: prepared.sessionId,
      actor: structuredClone(prepared.actor),
      committedAt: out.committedAt,
      ...(out.revision !== undefined ? { revision: out.revision } : {}),
      ...(out.value !== undefined ? { value: out.value } : {}),
      ...(out.sourceRevision !== undefined ? { sourceRevision: out.sourceRevision } : {}),
    }
    this.receipts.set(`${prepared.sessionId}:${prepared.operationId}`, receipt)
    return structuredClone(receipt)
  }
}

/** fork/import payload 的宽松内部视图（运行时字段按 kind 存在）。 */
interface ChangeSetLike {
  source?: { sessionId: string; branchId: string }
  sourceRevision?: number
  initialRevision?: number
}

function sameOwnership(
  a: { rootSessionId: string; parentSessionId?: string; parentToolUseId?: string },
  b: { rootSessionId: string; parentSessionId?: string; parentToolUseId?: string },
): boolean {
  return a.rootSessionId === b.rootSessionId
    && (a.parentSessionId ?? null) === (b.parentSessionId ?? null)
    && (a.parentToolUseId ?? null) === (b.parentToolUseId ?? null)
}
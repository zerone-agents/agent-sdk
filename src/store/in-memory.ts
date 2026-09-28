/**
 * InMemorySessionStore —— v4 参考实现（issue #131）。
 * 真 CAS / tombstone / 回执语义；conformance 套件的依据实现（App 对照实现 SQLite adapter）。
 *
 * 提交模型（评审修复后）：**同步提交单元** —— 校验（指纹/CAS/归属/源快照）→ 构造
 * working 副本上 apply → 原子发布；任何失败零残留（不遗留记录、行或凭据）。
 * 校验与发布之间**无 await 让出点**（并发 create-only/fork 不可交错——真实 adapter 由
 * 事务提供同等保证）。
 *
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
  SessionOwnership,
  SessionState,
} from './types.js'
import { OwnershipMismatchError, SessionConflictError, SessionDataInvalidError, WriteNotAuthorizedError } from './errors.js'
import { applyChangeSet, initialStoreData, type StoreData } from './apply.js'
import { fingerprintOperation } from './fingerprint.js'
import { assertIntentShape } from './types.js'
import type { OperationIntent } from './types.js'
import type { CommitEntryOpts, OwnershipFilter, SessionStore } from './session-store.js'

const TRANSCRIPT_KINDS: ReadonlySet<string> = new Set(['checkpoint', 'compact', 'rollback', 'branch-switch', 'append', 'revise', 'fork', 'import'])

interface SessionRow {
  data: StoreData
  tombstone?: { deletedAt: string }
}

/** fork/import payload 的宽松内部视图（运行时字段按 kind 存在）。 */
interface ChangeSetLike {
  source?: { sessionId: string; branchId: string }
  sourceRevision?: number
  initialRevision?: number
  ownership?: SessionOwnership
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionRow>()
  /** 同库共享记录表（recordId 全局唯一；fork「引用」语义的基础——spec §4.4）。
   * 非 readonly：原子提交按「发布」整体替换（失败不污染）。 */
  private records = new Map<string, MessageRecord>()
  private readonly receipts = new Map<string, OperationReceipt>()

  // ── 读取（返回值一律隔离——修改读取结果不能改写存储，评审 #4） ──

  async loadSession(sessionId: string): Promise<SessionState | null> {
    const row = this.sessions.get(sessionId)
    if (!row || row.tombstone) return null
    return structuredClone(row.data.state)
  }

  async loadRecords(sessionId: string, recordIds: string[]): Promise<(MessageRecord | null)[]> {
    const row = this.sessions.get(sessionId)
    if (!row || row.tombstone) return recordIds.map(() => null)
    return recordIds.map((id) => {
      const r = this.records.get(id)
      return r ? structuredClone(r) : null
    })
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
      const r = this.records.get(id)
      if (!r) throw new SessionDataInvalidError(sessionId, `unknown record id in branch: ${id}`)
      return structuredClone(r)
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
        const r = this.records.get(id)
        if (!r) throw new SessionDataInvalidError(sessionId, `unknown record id in context: ${id}`)
        out.push(structuredClone(r.message))
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

  // ── 提交（同步提交单元：校验 → working apply → 原子发布） ──

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
    const existing = this.sessions.get(sessionId)
    if (existing?.tombstone) {
      throw new WriteNotAuthorizedError(`session ${sessionId} is deleted (tombstone)`)
    }

    // ── 校验段（全部同步；与发布之间无 await——评审 #2：create-only 不可交错） ──
    this.assertPreparedShape(sessionId, prepared)                          // 评审：指纹一致 ≠ 结构合法
    const changeSet = prepared.payload as ChangeSetLike
    // 归属不可变（评审 S1：fork/import 不得改写已登记 ownership——spec §2.3，
    // 防止 target 脱离 root、级联删除失联）
    if (existing && changeSet.ownership !== undefined
      && !sameOwnership(existing.data.state.ownership, changeSet.ownership)) {
      throw new OwnershipMismatchError(
        `session ${sessionId} ownership is already established; fork/import must not rewrite it (spec §2.3)`,
      )
    }
    const effectiveOwnership: SessionOwnership = existing?.data.state.ownership
      ?? changeSet.ownership
      ?? { rootSessionId: sessionId }
    this.assertAncestorsRegistered(sessionId, effectiveOwnership)          // 评审 #5：全写入口祖先校验
    this.checkCas(sessionId, existing, prepared)                           // 评审 #6：branches 区分 transcript
    if (prepared.kind === 'fork') {
      // 源快照冻结校验（spec §4.4）：同步读内存快照——不是审计值
      const srcRow = this.sessions.get(changeSet.source!.sessionId)
      if (!srcRow || srcRow.tombstone || srcRow.data.state.revision !== changeSet.sourceRevision) {
        throw new SessionConflictError(sessionId, null, srcRow && !srcRow.tombstone ? srcRow.data.state.revision : undefined)
      }
    }

    // ── working 副本 apply（评审 #1：失败零残留） ──
    const working: StoreData = {
      state: existing ? structuredClone(existing.data.state) : initialStoreData(sessionId, effectiveOwnership, now).state,
      records: new Map(this.records),
      todos: existing ? structuredClone(existing.data.todos) : [],
    }
    applyChangeSet(sessionId, working, changeSet as never, { committedAt: now })

    // revision（import 的 initialRevision 例外——spec §8.3）
    if (prepared.kind === 'import' && changeSet.initialRevision !== undefined) {
      working.state.revision = changeSet.initialRevision
    } else {
      working.state.revision += 1
    }
    working.state.updatedAt = now

    // ── 原子发布 ──
    this.records = working.records
    if (existing) {
      existing.data = working
    } else {
      this.sessions.set(sessionId, { data: working })
    }
    return this.recordReceipt(prepared, {
      revision: working.state.revision,
      committedAt: now,
      auth: opts?.auth,
      ...(prepared.kind === 'fork' ? { sourceRevision: changeSet.sourceRevision } : {}),
    })
  }

  async saveTodos(sessionId: string, prepared: PreparedOperation, opts?: CommitEntryOpts): Promise<OperationReceipt> {
    this.verifyFingerprint(sessionId, prepared)
    this.assertPreparedShape(sessionId, prepared)
    if (prepared.kind !== 'save-todos') throw new SessionDataInvalidError(sessionId, 'saveTodos expects kind "save-todos"')
    const payload = prepared.payload as { todos: TodoInfo[]; ownership?: SessionOwnership }
    // tombstone 拒绝（迟到写入）；祖先校验基于「已存 ownership ?? 传入 ownership」（评审 #5）；首写创建 todo-only 行
    const row = this.ensureRow(sessionId, payload.ownership)
    row.data.todos = structuredClone(payload.todos)
    const now = new Date().toISOString()
    row.data.state.updatedAt = now
    // spec §3.2/§4.7：todos 不推进 transcript revision——回执不伪造 revision
    return this.recordReceipt(prepared, { committedAt: now, auth: opts?.auth })
  }

  async deleteSession(sessionId: string, prepared: PreparedOperation, opts?: CommitEntryOpts): Promise<OperationReceipt> {
    this.verifyFingerprint(sessionId, prepared)
    this.assertPreparedShape(sessionId, prepared)
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

  /**
   * commit 边界结构校验（评审 S3）：指纹一致 ≠ 结构合法——journal 反序列化后的
   * prepared 必须重新过形状校验（transcript 类必需前提、fork/import 的 create-only
   * 字面量、外层 kind / payload kind 一致性、例外 kind 禁带前提）。
   */
  private assertPreparedShape(sessionId: string, prepared: PreparedOperation): void {
    const p = prepared as { payload: Record<string, unknown>; expectedRevision?: number | null }
    let intentLike: OperationIntent
    switch (prepared.kind) {
      case 'save-todos':
        intentLike = {
          kind: 'save-todos',
          todos: p.payload.todos as TodoInfo[],
          ...(p.payload.ownership !== undefined ? { ownership: p.payload.ownership as SessionOwnership } : {}),
        }
        break
      case 'delete':
        intentLike = { kind: 'delete', ...(p.payload.cascadeOwned !== undefined ? { cascadeOwned: p.payload.cascadeOwned as boolean } : {}) }
        break
      case 'register':
        intentLike = { kind: 'register', ownership: p.payload.ownership as SessionOwnership }
        break
      default:
        intentLike = {
          kind: prepared.kind,
          changeSet: p.payload as never,
          expectedRevision: p.expectedRevision,
        } as OperationIntent
    }
    assertIntentShape(sessionId, intentLike)
  }

  /** register 提交（spec §2.3 登记协议）：幂等、无 revision、不产生 transcript。 */
  private async commitRegister(sessionId: string, prepared: PreparedOperation, opts?: CommitEntryOpts): Promise<OperationReceipt> {
    this.assertPreparedShape(sessionId, prepared)
    const ownership = (prepared.payload as { ownership: SessionOwnership }).ownership
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

  /** 登记/写入前的事务化校验入口。**已存在行也按已存 ownership 校验祖先**（评审 #5：
  root 删除后，已登记子 session 的后续写入同样拒绝）。 */
  ensureRow(sessionId: string, ownership?: SessionOwnership): SessionRow {
    const row = this.sessions.get(sessionId)
    if (row?.tombstone) {
      throw new WriteNotAuthorizedError(`session ${sessionId} is deleted (tombstone)`)
    }
    const effectiveOwnership: SessionOwnership = row?.data.state.ownership ?? ownership ?? { rootSessionId: sessionId }
    this.assertAncestorsRegistered(sessionId, effectiveOwnership)
    if (row) return row
    const now = new Date().toISOString()
    const created: SessionRow = { data: initialStoreData(sessionId, effectiveOwnership, now) }
    created.data.records = this.records   // 共享全局记录表（同库引用语义）
    this.sessions.set(sessionId, created)
    return created
  }

  private assertAncestorsRegistered(sessionId: string, ownership: SessionOwnership): void {
    for (const pid of [ownership.rootSessionId, ownership.parentSessionId]) {
      if (!pid || pid === sessionId) continue
      const p = this.sessions.get(pid)
      if (!p || p.tombstone) {
        throw new WriteNotAuthorizedError(`ownership target ${pid} is not registered or deleted (register protocol, spec §2.3)`)
      }
    }
  }

  private requireRow(sessionId: string): SessionRow {
    const row = this.sessions.get(sessionId)
    if (!row || row.tombstone) throw new SessionDataInvalidError(sessionId, 'session not found')
    return row
  }

  /**
   * CAS 校验（评审 #6）：create-only 以「**transcript 是否存在**」（branches 非空）判定——
   * register/todo-only 行（revision=0 且无 transcript）不阻挡首次 checkpoint；
   * 合法导入 initialRevision=0 的行已有 transcript，不得被 create-only 覆盖。
   */
  private checkCas(sessionId: string, row: SessionRow | undefined, prepared: PreparedOperation): void {
    const premise = (prepared as { expectedRevision?: number | null }).expectedRevision
    if (premise === undefined) return // premise-free kinds（不经 commit 的 transcript 路径）
    const hasTranscript = !!row && !row.tombstone && row.data.state.branches.length > 0
    if (premise === null) {
      if (hasTranscript) {
        throw new SessionConflictError(sessionId, null, row!.data.state.revision)
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

function sameOwnership(a: SessionOwnership, b: SessionOwnership): boolean {
  return a.rootSessionId === b.rootSessionId
    && (a.parentSessionId ?? null) === (b.parentSessionId ?? null)
    && (a.parentToolUseId ?? null) === (b.parentToolUseId ?? null)
}
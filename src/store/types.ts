/**
 * SessionStore v4 契约类型（issue #131，SPEC v1.4 已冻结）。
 *
 * 分层（实施总览 §0）：plan*（规划，读 store）→ prepareOperation（冻结+指纹，纯函数）
 * → adapter commit（applyChangeSet + CAS 壳）。领域规划全部在 SDK，adapter 不承担。
 *
 * P1 范围：类型一次定稿（全部 operation kind）；凭据去重/fencing 校验/保留窗口为 P2。
 */
import type { NormalizedMessageParam } from '../providers/types.js'
import type { TodoInfo } from '../types.js'
import type { SessionMetadata } from '../session.js'
import { SessionDataInvalidError } from './errors.js'

// ============================================================================
// §2 数据模型
// ============================================================================

export type RecordKind = 'message' | 'summary'

/** 不可变正文记录（只追加；revise = 新 recordId + 同 messageId）。 */
export interface MessageRecord {
  recordId: string
  messageId: string
  /** 消息内容（id === messageId）。 */
  message: NormalizedMessageParam
  actor: ActorRef
  createdAt: string
  /** summary 记录不进入 effective（折叠只处理 message；spec §2.2-#5）。 */
  kind: RecordKind
}

export interface ActorRef {
  kind: 'main' | 'subagent' | 'app-op' | 'import' | 'sdk'
  /** 执行者标识（如 subagent sessionId）。 */
  id?: string
}

/** session 级归属（root/parent 链；首次写入确立、不可变更——spec §2.3）。 */
export interface SessionOwnership {
  rootSessionId: string
  parentSessionId?: string
  parentToolUseId?: string
}

/** summary 覆盖的不可变消息版本序列（仅 kind:'message' 记录；单层展开——spec §2.2-#4）。 */
export interface CoversRef {
  branchId: string
  recordIds: string[]
}

export type ContextSegment =
  | { kind: 'records'; recordIds: string[] }
  | { kind: 'summary'; summaryRecordId: string; covers: CoversRef }

/** 模型上下文引用（segments 按序拼接即 resume 的模型消息序列；组装权威）。 */
export interface ContextRef {
  segments: ContextSegment[]
}

export interface Branch {
  branchId: string
  /** 完整追加日志（只增；含被修订旧版本与 summary 记录）。 */
  records: string[]
  /** 当前有效消息引用序列（折叠生成：每 messageId 取最后版本、首现序）。 */
  effective: string[]
  context: ContextRef
  createdAt: string
  createdByOpId?: string
}

export interface SessionState {
  sessionId: string
  metadata: SessionMetadata
  branches: Branch[]
  currentBranchId: string
  /** 统一 CAS 版本（保护一切 transcript/历史/上下文变更；todos/register 不推进）。 */
  revision: number
  createdAt: string
  updatedAt: string
  ownership: SessionOwnership
}

export interface HistoryQuery {
  cursor?: string
  limit?: number
  /** true = records 按 messageId 归组的版本审计视图（含 summary 压缩事件）。 */
  includeSuperseded?: boolean
}

export interface HistoryPage {
  records: MessageRecord[]
  nextCursor?: string
}

// ============================================================================
// §3.1 ChangeSet（操作意图，SDK 计算）
// ============================================================================

export interface NewRecord {
  /** SDK 生成（prepare 时冻结）。 */
  recordId: string
  /** 含 id === messageId。 */
  message: NormalizedMessageParam
  actor: ActorRef
  kind?: RecordKind
}

export type ChangeSet =
  | { kind: 'checkpoint'; branchId: string; newRecords: NewRecord[]; context?: ContextRef; metadataPatch?: Partial<SessionMetadata> }
  | { kind: 'compact'; branchId: string; newRecords: NewRecord[]; context: ContextRef; summary: { summaryRecordId: string; covers: CoversRef } }
  | { kind: 'rollback'; fromBranchId: string; atMessageId: string; newBranchId: string; records: string[]; effective: string[]; context: ContextRef }
  | { kind: 'branch-switch'; toBranchId: string }
  | { kind: 'fork'; newSessionId: string; source: { sessionId: string; branchId: string }; sourceRevision: number; records: string[]; effective: string[]; context: ContextRef; metadata: Partial<SessionMetadata>; ownership: SessionOwnership }
  | { kind: 'append'; branchId: string; newRecords: NewRecord[]; contextAppend: boolean }
  | { kind: 'revise'; branchId: string; messageId: string; newRecord: NewRecord; contextUpdate: ContextRef }
  | { kind: 'import'; branchId: string; newRecords: NewRecord[]; effective: string[]; context: ContextRef; metadata: Partial<SessionMetadata>; ownership: SessionOwnership; initialRevision?: number }

// ============================================================================
// §3 OperationIntent / PreparedOperation / 回执
// ============================================================================

export type OperationIntent =
  // 普通正文操作：CAS 前提必填（null=create-only / 数字=精确匹配）——缺失在 prepare 边界拒绝
  | { kind: 'checkpoint' | 'compact' | 'rollback' | 'branch-switch' | 'append' | 'revise'; changeSet: ChangeSet; expectedRevision: number | null }
  // 目标必须不存在：create-only 字面量
  | { kind: 'fork' | 'import'; changeSet: ChangeSet; expectedRevision: null }
  // todos 域无 CAS——凭据去重保证幂等（P2）
  | { kind: 'save-todos'; todos: TodoInfo[]; ownership?: SessionOwnership }
  // 明确例外：delete 只依赖 fencing（tombstone/授权），无 revision 前提
  | { kind: 'delete'; cascadeOwned?: boolean }
  // 归属登记（幂等；root 首写前 / 派生前——不产生 transcript、不推进 revision）
  | { kind: 'register'; ownership: SessionOwnership }

export type OperationKind = ChangeSet['kind'] | 'save-todos' | 'delete' | 'register'

export interface AuthorizationContext {
  ownerId: string
  epoch: number
  leaseToken?: string
}

export interface PreparedBase {
  operationId: string
  fingerprint: string
  sessionId: string
  actor: ActorRef
  /** fencing 绑定身份；重试可经提交入口 opts.auth 覆盖（执行参数，不进指纹）。 */
  auth?: AuthorizationContext
}

/** 按 kind 类型化：版本前提类型级封闭——不存在「无守卫写」通道（spec §3.2）。 */
export type PreparedOperation = PreparedBase & (
  | { kind: 'checkpoint' | 'compact' | 'rollback' | 'branch-switch' | 'append' | 'revise'; payload: ChangeSet; expectedRevision: number | null }
  | { kind: 'fork' | 'import'; payload: ChangeSet; expectedRevision: null }
  | { kind: 'save-todos'; payload: { todos: TodoInfo[]; ownership?: SessionOwnership } }
  | { kind: 'delete'; payload: { cascadeOwned?: boolean } }
  | { kind: 'register'; payload: { ownership: SessionOwnership } }
)

export type CommitValue =
  | { messageId: string; recordId: string }
  | { deleted: boolean }
  | Record<string, unknown>

/** 统一回执：commit 返回与 queryOperation(committed) 共用；revision 可省略
 *  （save-todos / register / todo-only session 不伪造 transcript revision）。 */
export interface OperationReceipt {
  operationId: string
  fingerprint: string
  kind: OperationKind
  sessionId: string
  actor: ActorRef
  committedAt: string
  revision?: number
  value?: CommitValue
  /** fork 专用：提交校验通过的源快照 revision（spec §4.4）。 */
  sourceRevision?: number
}

export type OperationLookup =
  | { status: 'committed'; receipt: OperationReceipt }
  | { status: 'not-committed' }
  | { status: 'recycled' }

export type CommitResult = OperationReceipt
export type TodoCommitResult = OperationReceipt
export type DeleteResult = OperationReceipt

// ============================================================================
// Intent 形状校验（App 冻结评审 #3：外层 kind 与 payload kind 一致性 + 前提封闭）
// ============================================================================

const TRANSCRIPT_KINDS: ReadonlySet<string> = new Set(['checkpoint', 'compact', 'rollback', 'branch-switch', 'append', 'revise'])
const CREATE_ONLY_KINDS: ReadonlySet<string> = new Set(['fork', 'import'])
const PREMISE_FREE_KINDS: ReadonlySet<string> = new Set(['save-todos', 'delete', 'register'])

/**
 * 运行时校验 operation intent 形状（prepare/commit 边界的第一道防线；类型级联合
 * 已在编译期封闭，本函数拦截 JS/反序列化输入——spec §3 v1.4、App 冻结评审 #3）。
 */
export function assertIntentShape(sessionId: string, intent: OperationIntent): void {
  const kind = (intent as { kind?: string }).kind
  if (typeof kind !== 'string') {
    throw new SessionDataInvalidError(sessionId, 'intent.kind is required')
  }
  if ('changeSet' in intent) {
    const payloadKind = (intent as { changeSet: { kind?: string } }).changeSet?.kind
    if (payloadKind !== kind) {
      throw new SessionDataInvalidError(
        sessionId,
        `intent.kind "${kind}" does not match changeSet.kind "${String(payloadKind)}"`,
      )
    }
  }
  const hasPremise = 'expectedRevision' in intent && (intent as { expectedRevision?: unknown }).expectedRevision !== undefined
  if (TRANSCRIPT_KINDS.has(kind)) {
    if (!hasPremise) {
      throw new SessionDataInvalidError(
        sessionId,
        `${kind}: expectedRevision is required (number | null) — no guard-free write channel`,
      )
    }
  } else if (CREATE_ONLY_KINDS.has(kind)) {
    if ((intent as { expectedRevision?: unknown }).expectedRevision !== null) {
      throw new SessionDataInvalidError(
        sessionId,
        `${kind}: expectedRevision must be the create-only literal null`,
      )
    }
  } else if (PREMISE_FREE_KINDS.has(kind)) {
    if (hasPremise) {
      throw new SessionDataInvalidError(
        sessionId,
        `${kind}: must not carry a revision premise`,
      )
    }
  }
  if (kind === 'save-todos' && !Array.isArray((intent as { todos?: unknown }).todos)) {
    throw new SessionDataInvalidError(sessionId, 'save-todos: todos array required')
  }
  if (kind === 'register' && !(intent as { ownership?: unknown }).ownership) {
    throw new SessionDataInvalidError(sessionId, 'register: ownership required')
  }
}
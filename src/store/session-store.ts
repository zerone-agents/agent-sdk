/**
 * SessionStore v4 —— adapter 持久化接口（issue #131，SPEC v1.4；总览 §0）。
 *
 * **无 prepare**：领域规划（ChangeSet 计算）在 SDK 编排层（plan* + prepareOperation）；
 * adapter 只实现持久化原语与事务。三处提交入口（commit / deleteSession / saveTodos）
 * 签名一致接受 opts.auth（执行参数；P1 仅透传进回执，P2 启用 fencing 校验）。
 */
import type { NormalizedMessageParam } from '../providers/types.js'
import type { TodoInfo } from '../types.js'
import type { SessionMetadata } from '../session.js'
import type {
  AuthorizationContext,
  DeleteResult,
  HistoryPage,
  HistoryQuery,
  MessageRecord,
  OperationLookup,
  PreparedOperation,
  SessionState,
  CommitResult,
  TodoCommitResult,
} from './types.js'

export interface CommitEntryOpts {
  auth?: AuthorizationContext
}

export interface OwnershipFilter {
  rootSessionId?: string
  parentSessionId?: string
}

export interface SessionStore {
  loadSession(sessionId: string): Promise<SessionState | null>
  loadRecords(sessionId: string, recordIds: string[]): Promise<(MessageRecord | null)[]>
  loadHistory(sessionId: string, branchId: string, opts?: HistoryQuery): Promise<HistoryPage>
  loadContext(sessionId: string, branchId: string): Promise<NormalizedMessageParam[]>
  commit(sessionId: string, prepared: PreparedOperation, opts?: CommitEntryOpts): Promise<CommitResult>
  queryOperation(sessionId: string, operationId: string): Promise<OperationLookup>
  deleteSession(sessionId: string, prepared: PreparedOperation, opts?: CommitEntryOpts): Promise<DeleteResult>
  listSessions?(filter?: OwnershipFilter): Promise<SessionMetadata[]>
  loadTodos(sessionId: string): Promise<TodoInfo[]>
  saveTodos(sessionId: string, prepared: PreparedOperation, opts?: CommitEntryOpts): Promise<TodoCommitResult>
}
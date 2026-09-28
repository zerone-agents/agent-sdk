/**
 * SessionStore v4 — P1 集成导出（issue #131）。
 *
 * App 集成测试入口：`@zerone-agent/agent-sdk/store`
 * 这是 P1 范围的最小导出面（非最终 v4 公开 API——P3 统一定）。
 *
 * P1 边界：queryOperation 基础回执；同 ID 去重/重试状态机/fencing 校验/保留窗口 = P2。
 */
export type {
  ActorRef,
  AuthorizationContext,
  Branch,
  ChangeSet,
  CommitResult,
  CommitValue,
  ContextRef,
  ContextSegment,
  CoversRef,
  DeleteResult,
  HistoryPage,
  HistoryQuery,
  MessageRecord,
  NewRecord,
  OperationIntent,
  OperationKind,
  OperationLookup,
  OperationReceipt,
  PreparedOperation,
  RecordKind,
  SessionOwnership,
  SessionState,
  TodoCommitResult,
} from './types.js'

export { assertIntentShape } from './types.js'

export {
  OperationConflictError,
  OwnershipMismatchError,
  RollbackTargetInvalidError,
  SessionConflictError,
  SessionDataInvalidError,
  WriteNotAuthorizedError,
} from './errors.js'

export { canonicalJSON, fingerprintOperation } from './fingerprint.js'
export type { OperationPayload } from './fingerprint.js'

export { prepareOperation } from './prepare.js'
export type { PrepareOptions } from './prepare.js'

export { buildCovers, foldEffective, rebuildRollback } from './algorithm.js'
export type { RecordLookup, RollbackPlan } from './algorithm.js'

export { planCompact, planFork, planRollback } from './plan.js'
export type { PlanCompactInput } from './plan.js'

export type { CommitEntryOpts, OwnershipFilter, SessionStore } from './session-store.js'

export { InMemorySessionStore } from './in-memory.js'

export { runSessionStoreConformance } from './conformance.js'
export type { ConformanceOptions } from './conformance.js'
/**
 * SessionStore v4 — 集成导出（issue #131；P1 契约 + P2 fencing + P3 编排接入）。
 *
 * App 集成入口：`@zerone-agent/agent-sdk/store`
 * - conformance：`runSessionStoreConformance(store, { phases: ['p1'] })`（无 fencing）；
 *   `phases: ['p2']` 需 p2Context（fencing 实例）
 * - 编排：`WriteCoordinator`（execute/query/retry 统一写入入口）
 * - 治理：`createSessionManagerV2`（revise/rollback/fork/delete/todos）
 * - 文件持久化：`FileSessionStore`
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
export type { InMemorySessionStoreOptions } from './in-memory.js'

export { runSessionStoreConformance, createInMemoryP2Context } from './conformance.js'
export type { ConformanceOptions, P2TestContext } from './conformance.js'

// ── P3：编排接入（issue #131）──

export { WriteCoordinator, CoordinatorUnknownError } from './coordinator.js'
export type { WriteCoordinatorOptions } from './coordinator.js'

export { NoopJournal } from './journal.js'
export type { OperationJournal } from './journal.js'

export { CommittedMessageIndex } from './index-map.js'

export { createSessionManagerV2 } from './session-manager.js'
export type { SessionManagerV2, SessionManagerV2Init } from './session-manager.js'

export { FileSessionStore } from './file-store.js'
export type { FileSessionStoreOptions } from './file-store.js'
export type { StoreSnapshot } from './in-memory.js'
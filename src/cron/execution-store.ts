import type {
  CronExecution,
  CronExecutionQuery,
  CronExecutionStatus,
} from './types.js'

export type ExecutionStatusPatch = {
  output?: string
  error?: string
  startedAt?: number
  completedAt?: number
}

export type ExecutionClaimResult =
  | { kind: 'claimed'; execution: CronExecution }
  | { kind: 'duplicate'; execution: CronExecution }
  | { kind: 'skipped'; execution: CronExecution }

/**
 * Claim input — every claim() carries exactly ONE identity, discriminated by
 * trigger so an inconsistent (trigger, dedupKey) pair is UNREPRESENTABLE:
 * - scheduled: the DEFAULT identity `${taskId}:${scheduledFireTime}`
 *   (no dedupKey; time-derived, permanent).
 * - manual: a REQUIRED caller-provided custom `dedupKey`. A manual claim can
 *   therefore never occupy the DEFAULT identity, and its identity is
 *   process-local (manual records are never replayed into the dedup index).
 */
export type ExecutionClaimInput =
  | {
      taskId: string
      scheduledFireTime: number
      trigger: 'scheduled'
      dedupKey?: undefined
    }
  | {
      taskId: string
      scheduledFireTime: number
      trigger: 'manual'
      /**
       * Custom dedup identity, unique per submission (e.g. `manual:<uuid>`).
       * Required: identity must not be encoded as a synthetic fire time.
       */
      dedupKey: string
    }

/**
 * Port: persistence + atomic bookkeeping for execution records.
 *
 * Claim identity — every claim() carries exactly ONE identity (see
 * {@link ExecutionClaimInput}):
 * - scheduled claims use the DEFAULT identity
 *   `` `${taskId}:${scheduledFireTime}` ``;
 * - manual claims MUST provide a custom `dedupKey`.
 *
 * Guarantees required from implementations (issue #42):
 * - claim() is atomic per identity: the DEFAULT identity `` `${taskId}:
 *   ${scheduledFireTime}` `` must be claimed at most once per store, EVER,
 *   including across process restarts; re-claiming it -> `duplicate`
 *   (scheduled catch-up / post-downtime dedup depends on this).
 * - custom `dedupKey` identities must be unique per submission; in-process
 *   dedup must hold, but persistence across process restarts is NOT required
 *   (manual triggers are never replayed). A manual record never occupies the
 *   DEFAULT identity `${taskId}:${scheduledFireTime}`. The FileExecutionStore
 *   behaves exactly this way: its `byFire` map registers the custom key at
 *   claim time, while rebuild-from-log derives DEFAULT keys only for
 *   scheduled records.
 * - at most one active (pending/running) execution per task; a new claim for
 *   an active task records a `skipped` execution. The active set is
 *   trigger-agnostic and must survive restarts for EVERY trigger — replay
 *   rebuilds it for manual pending/running records too, otherwise a manual
 *   run that crashed mid-flight would silently stop blocking new claims.
 * - recoverInterrupted() moves startup-time pending/running records to
 *   `interrupted` and returns how many were recovered.
 */
export interface ExecutionStore {
  recoverInterrupted(): Promise<number>
  claim(input: ExecutionClaimInput): Promise<ExecutionClaimResult>
  get(executionId: string): Promise<CronExecution | null>
  list(query?: CronExecutionQuery): Promise<CronExecution[]>
  updateStatus(
    executionId: string,
    status: CronExecutionStatus,
    patch?: ExecutionStatusPatch,
  ): Promise<CronExecution | null>
}

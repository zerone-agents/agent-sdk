import type {
  CronExecution,
  CronExecutionQuery,
  CronExecutionStatus,
  CronExecutionTrigger,
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
 * Port: persistence + atomic bookkeeping for execution records.
 *
 * Claim identity — every claim() carries exactly ONE identity:
 * - the caller-provided `dedupKey` when present (manual triggers pass
 *   `manual:<uuid>` so identity is not encoded as a synthetic fire time);
 * - otherwise the DEFAULT identity `` `${taskId}:${scheduledFireTime}` ``.
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
 *   an active task records a `skipped` execution.
 * - recoverInterrupted() moves startup-time pending/running records to
 *   `interrupted` and returns how many were recovered.
 */
export interface ExecutionStore {
  recoverInterrupted(): Promise<number>
  claim(input: {
    taskId: string
    scheduledFireTime: number
    trigger: CronExecutionTrigger
    /**
     * Optional dedup identity. When omitted, the default key
     * `${taskId}:${scheduledFireTime}` applies (keeps scheduled
     * restart-dedup byte-identical). Manual triggers pass a unique
     * key so identity is not encoded as a synthetic fire time.
     */
    dedupKey?: string
  }): Promise<ExecutionClaimResult>
  get(executionId: string): Promise<CronExecution | null>
  list(query?: CronExecutionQuery): Promise<CronExecution[]>
  updateStatus(
    executionId: string,
    status: CronExecutionStatus,
    patch?: ExecutionStatusPatch,
  ): Promise<CronExecution | null>
}

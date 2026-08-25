import type { CronClock, CronTimer } from './clock.js'
import { waitViaTimer } from './clock.js'
import { emitCronEvent, type CronEventSink } from './events.js'
import type {
  ExecutionClaimInput,
  ExecutionClaimResult,
  ExecutionStore,
} from './execution-store.js'
import type { CronExecutor } from './executor.js'
import type { CronStorage } from './storage.js'
import type { CronExecution, CronExecutionTrigger, CronTask } from './types.js'

export const DEFAULT_EXECUTION_TIMEOUT_MS = 30 * 60_000
const DRAIN_POLL_MS = 25

export class CronExecutionTimeoutError extends Error {
  constructor() {
    super('cron execution timed out')
    this.name = 'CronExecutionTimeoutError'
  }
}

export class CronExecutionInterruptedError extends Error {
  constructor(reason: string) {
    super(`cron execution interrupted: ${reason}`)
    this.name = 'CronExecutionInterruptedError'
  }
}

function abortReason(signal: AbortSignal): unknown {
  return (signal as AbortSignal & { reason?: unknown }).reason
}

export interface CronExecutionCoordinatorDeps {
  executionStore: ExecutionStore
  executor: CronExecutor
  storage: CronStorage
  clock: CronClock
  timer: CronTimer
  events?: CronEventSink
  executionTimeoutMs?: number
}

interface ActiveRun {
  executionId: string
  promise: Promise<CronExecution>
  abort: AbortController
}

interface PendingSubmission {
  promise: Promise<CronExecution>
  abort: AbortController
}

/** Handles wired at submission time and passed through claimAndRun → run. */
interface SubmissionHandles {
  abort: AbortController
  abortPromise: Promise<never>
  timeoutHandle: unknown
  submission: PendingSubmission
}

/**
 * The two phases of a submitted execution (issue #51). `claimed` settles as
 * soon as the claim is durable — the initial `pending` record for a new
 * claim, the persisted `skipped` record when the task already has an active
 * execution, or the existing record for a duplicate. `completion` settles at
 * the terminal state; for duplicate/skipped submissions it is the same
 * record. Both reject on pre-claim or claim persistence failure.
 */
export interface SubmittedExecution {
  claimed: Promise<CronExecution>
  completion: Promise<CronExecution>
}

/**
 * Owns the execution state machine: atomic claim, dedup, per-task
 * serialization (via the store), timeout, cancel, startup recovery, and
 * drain-on-stop. Scheduled and manual triggers share `submit()`.
 *
 * The abort controller, its timeout timer, and an abort-rejection promise are
 * wired synchronously at submission time, so timeout/suspend/stop take effect
 * even when the executor attaches its own abort listener afterwards (an
 * `abort` listener attached to an already-aborted signal never fires).
 */
/**
 * Module-private key for the SDK-internal submission split (issue #51).
 * A unique-symbol computed member keeps the seam OFF the public class
 * surface (consumers cannot name or import the symbol; the module is
 * unreachable through the package exports map) while preserving a
 * compiler-checked association: the dispatchCronSubmission helper indexes
 * this exact symbol against the REAL member type, so renames or signature
 * changes fail typecheck instead of drifting to runtime errors.
 */
const dispatchSubmissionKey = Symbol('cron.dispatchSubmission')

export class CronExecutionCoordinator {
  private active = new Map<string, ActiveRun>()
  private pending = new Set<PendingSubmission>()
  private started = false
  private draining = false

  constructor(private readonly deps: CronExecutionCoordinatorDeps) {}

  async start(): Promise<void> {
    if (this.started) return
    await this.deps.executionStore.recoverInterrupted()
    this.started = true
    this.draining = false
  }

  // Strict overloads: an inconsistent (trigger, dedupKey) pair is
  // UNREPRESENTABLE for TypeScript callers — scheduled submissions take no
  // dedupKey, manual submissions require one. The broad implementation
  // signature plus the runtime guards in dispatch() keep JS/host callers
  // honest too.
  submit(task: CronTask, scheduledFireTime: number, trigger: 'scheduled'): Promise<CronExecution>
  submit(
    task: CronTask,
    scheduledFireTime: number,
    trigger: 'manual',
    dedupKey: string,
  ): Promise<CronExecution>
  submit(
    task: CronTask,
    scheduledFireTime: number,
    trigger: CronExecutionTrigger,
    dedupKey?: string,
  ): Promise<CronExecution> {
    return this[dispatchSubmissionKey](task, scheduledFireTime, trigger, dedupKey).completion
  }

  /**
   * The single submission pipeline, split at the claim boundary (issue #51).
   * Broad-signature so the overloaded entry points (submit, and the
   * module-level dispatchCronSubmission helper) can delegate without
   * fighting overload resolution. Keyed by the module-private unique symbol
   * (see dispatchSubmissionKey): unreachable as a named public method, yet
   * the helper's calls stay compiler-checked against this real signature —
   * renames or signature changes fail typecheck instead of drifting.
   */
  [dispatchSubmissionKey](
    task: CronTask,
    scheduledFireTime: number,
    trigger: CronExecutionTrigger,
    dedupKey?: string,
  ): SubmittedExecution {
    if (!this.started || this.draining) {
      const err = new Error(
        'Cron coordinator is not accepting submissions (not started or draining)',
      )
      const rejected = Promise.reject<CronExecution>(err)
      // The caller may consume only one of the twins; the no-op catch keeps
      // the ignored branch from ever surfacing as an unhandled rejection.
      rejected.catch(() => {})
      return { claimed: rejected, completion: rejected }
    }
    const abort = new AbortController()
    const timeoutMs = this.deps.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS
    const timeoutHandle = this.deps.timer.setTimeout(
      () => abort.abort(new CronExecutionTimeoutError()),
      timeoutMs,
    )
    // Settles as soon as the signal aborts, regardless of executor behavior.
    const abortPromise = new Promise<never>((_, reject) => {
      abort.signal.addEventListener('abort', () => reject(abortReason(abort.signal)))
    })
    // If stop()/suspend() interrupts this submission while its claim is still
    // in flight, run()'s race (which attaches the abort handler) may never
    // happen — keep the pre-race rejection from becoming unhandled.
    abortPromise.catch(() => {})
    const submission: PendingSubmission = { abort, promise: null as never }
    this.pending.add(submission)
    const handles: SubmissionHandles = { abort, abortPromise, timeoutHandle, submission }

    // The claim phase: input guards + the durable claim, with the same
    // submission cleanup on rejection as a failed claim.
    const claimSettled: Promise<ExecutionClaimResult> = (async () => {
      // The claim input is a discriminated union: scheduled claims use the
      // DEFAULT time-derived identity; manual claims MUST carry a custom
      // dedupKey. Guard the untyped boundary (JS/host callers) so an
      // inconsistent (trigger, dedupKey) pair is refused instead of silently
      // remapped to the wrong identity. Nested branches — not a ternary — so
      // control-flow analysis narrows `dedupKey` to string after the throw.
      // Unknown trigger values must not fall through to the scheduled branch.
      if (trigger !== 'manual' && trigger !== 'scheduled') {
        throw new TypeError(`unknown cron execution trigger: ${String(trigger)}`)
      }
      let claimInput: ExecutionClaimInput
      if (trigger === 'manual') {
        // Non-empty string, matching the store's validation: undefined/null
        // would fall back to the DEFAULT identity, '' would collapse every
        // submission onto one key.
        if (typeof dedupKey !== 'string' || dedupKey.length === 0) {
          throw new TypeError('manual submissions require a non-empty string dedupKey')
        }
        claimInput = { taskId: task.id, scheduledFireTime, trigger, dedupKey }
      } else {
        if (dedupKey !== undefined) {
          throw new TypeError('scheduled submissions must not carry a dedupKey')
        }
        claimInput = { taskId: task.id, scheduledFireTime, trigger }
      }
      return await this.deps.executionStore.claim(claimInput)
    })().catch((err: unknown) => {
      // A rejected claim must not leak the submission: perform the same
      // cleanup as the non-claimed path below, otherwise stop()/suspend()
      // would later abort the leaked abortPromise with no handler attached
      // (unhandled CronExecutionInterruptedError).
      this.deps.timer.clearTimeout(timeoutHandle)
      this.pending.delete(submission)
      throw err
    })

    // Snapshot at the claim boundary — the initial-record contract must NOT
    // depend on the store adapter (review finding): ExecutionStore does not
    // require claim() to return a detached copy, and a compliant store may
    // hand back the very object it mutates in updateStatus(). The completion
    // reaction below enters run() (→ `running`) BEFORE the caller's `await
    // claimed` continuation runs, so without this copy enqueueNow() could
    // return `running` instead of the promised initial `pending` record.
    // All CronExecution fields are scalars — a shallow copy is faithful.
    const claimed: Promise<CronExecution> = claimSettled.then((c) => ({ ...c.execution }))
    // Twin-safety (claimed side): the submit() convenience consumes only
    // completion; the no-op observer keeps this projection from ever
    // surfacing as an unhandled rejection when the other twin is consumed.
    claimed.catch(() => {})

    const completion: Promise<CronExecution> = claimSettled.then((claim) => {
      if (claim.kind !== 'claimed') {
        // Duplicate or skipped: nothing to run — clean up and settle with
        // the existing durable record.
        this.deps.timer.clearTimeout(timeoutHandle)
        this.pending.delete(submission)
        return claim.execution
      }
      return this.run(task, claim.execution, handles)
    })
    // Twin-safety (completion side): a caller that consumes only `claimed`
    // must not leave this twin's rejection — a claim failure, or a
    // pre-executor updateStatus/emit failure inside run() — unobserved. The
    // no-op observer never changes what an explicit await/catch on
    // completion sees (multiple observers on the same settlement).
    completion.catch(() => {})

    submission.promise = completion
    return { claimed, completion }
  }

  async idle(): Promise<void> {
    const runs = [
      ...[...this.active.values()].map((r) => r.promise),
      ...[...this.pending].map((p) => p.promise),
    ]
    await Promise.allSettled(runs)
  }

  /** Immediately aborts active executions as `interrupted` (system suspend path). */
  async suspend(): Promise<void> {
    await this.interruptAll(new CronExecutionInterruptedError('suspend'))
  }

  async stop(options?: { drainMs?: number }): Promise<void> {
    if (!this.started) return
    this.draining = true
    const drainMs = options?.drainMs ?? 5_000
    const deadline = this.deps.clock.now() + drainMs
    while (this.hasInflight() && this.deps.clock.now() < deadline) {
      await waitViaTimer(this.deps.timer, DRAIN_POLL_MS)
    }
    await this.interruptAll(new CronExecutionInterruptedError('stop'))
    this.started = false
    this.draining = false
  }

  private hasInflight(): boolean {
    return this.active.size > 0 || this.pending.size > 0
  }

  private run(
    task: CronTask,
    execution: CronExecution,
    handles: SubmissionHandles,
  ): Promise<CronExecution> {
    const { abort, abortPromise, timeoutHandle, submission } = handles
    this.pending.delete(submission)

    const promise = (async (): Promise<CronExecution> => {
      const running =
        (await this.deps.executionStore.updateStatus(execution.id, 'running', {
          startedAt: this.deps.clock.now(),
        })) ?? execution
      await emitCronEvent(this.deps.events, {
        type: 'executionStarted',
        execution: running,
      })
      try {
        // lastFiredAt is best-effort bookkeeping — never fails an execution.
        // Promise.resolve guards against markFired implementations that
        // synchronously return undefined instead of a Promise.
        await Promise.resolve(
          this.deps.storage.markFired([task.id], this.deps.clock.now()),
        ).catch(() => {})
        const { output } = await Promise.race([
          this.deps.executor(task, {
            executionId: execution.id,
            trigger: execution.trigger,
            signal: abort.signal,
          }),
          abortPromise,
        ])
        return await this.finish(execution.id, 'succeeded', {
          output,
          completedAt: this.deps.clock.now(),
        })
      } catch (err) {
        const reason = err instanceof Error ? err : new Error(String(err))
        const signalReason = abort.signal.aborted ? abortReason(abort.signal) : undefined
        if (signalReason instanceof CronExecutionTimeoutError) {
          return await this.finish(execution.id, 'timeout', {
            error: `execution timed out after ${this.deps.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS}ms`,
            completedAt: this.deps.clock.now(),
          })
        }
        if (abort.signal.aborted) {
          return await this.finish(execution.id, 'interrupted', {
            error: signalReason instanceof CronExecutionInterruptedError
              ? signalReason.message
              : reason.message,
            completedAt: this.deps.clock.now(),
          })
        }
        return await this.finish(execution.id, 'failed', {
          error: reason.message,
          completedAt: this.deps.clock.now(),
        })
      } finally {
        this.deps.timer.clearTimeout(timeoutHandle)
        this.active.delete(execution.id)
      }
    })()

    this.active.set(execution.id, { executionId: execution.id, promise, abort })
    return promise
  }

  private async finish(
    executionId: string,
    status: CronExecution['status'],
    patch: { output?: string; error?: string; completedAt?: number },
  ): Promise<CronExecution> {
    const final =
      (await this.deps.executionStore.updateStatus(executionId, status, patch)) ?? undefined
    if (final) {
      await emitCronEvent(this.deps.events, { type: 'executionCompleted', execution: final })
    }
    return (
      final ?? {
        id: executionId,
        cronTaskId: '',
        scheduledFireTime: 0,
        trigger: 'scheduled',
        status,
        ...patch,
      }
    )
  }

  private async interruptAll(reason: CronExecutionInterruptedError): Promise<void> {
    for (const run of [...this.active.values()]) run.abort.abort(reason)
    for (const submission of [...this.pending]) submission.abort.abort(reason)
    await this.idle()
  }
}

/**
 * SDK-INTERNAL friend of CronExecutionCoordinator (issue #51): exposes the
 * claim/completion split to createCronService() (CronService.enqueueNow)
 * WITHOUT putting it on the exported class — the public coordinator surface
 * keeps only submit(). This module is unreachable through the package
 * exports map (only '.' and './cron/node' are exposed), so consumers cannot
 * import it; the type-contract file locks that `.dispatch` is not reachable
 * on the class. Strict overloads mirror submit()'s contract.
 */
export function dispatchCronSubmission(
  coordinator: CronExecutionCoordinator,
  task: CronTask,
  scheduledFireTime: number,
  trigger: 'scheduled',
): SubmittedExecution
export function dispatchCronSubmission(
  coordinator: CronExecutionCoordinator,
  task: CronTask,
  scheduledFireTime: number,
  trigger: 'manual',
  dedupKey: string,
): SubmittedExecution
export function dispatchCronSubmission(
  coordinator: CronExecutionCoordinator,
  task: CronTask,
  scheduledFireTime: number,
  trigger: CronExecutionTrigger,
  dedupKey?: string,
): SubmittedExecution {
  // Direct symbol indexing — NO assertion bypass: this call is checked
  // against the real member type, so renames or signature changes fail
  // typecheck here instead of drifting to runtime errors.
  return coordinator[dispatchSubmissionKey](task, scheduledFireTime, trigger, dedupKey)
}

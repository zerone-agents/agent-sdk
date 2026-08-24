import type { CronClock, CronTimer } from './clock.js'
import { waitViaTimer } from './clock.js'
import { emitCronEvent, type CronEventSink } from './events.js'
import type { ExecutionClaimInput, ExecutionStore } from './execution-store.js'
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
 * Owns the execution state machine: atomic claim, dedup, per-task
 * serialization (via the store), timeout, cancel, startup recovery, and
 * drain-on-stop. Scheduled and manual triggers share `submit()`.
 *
 * The abort controller, its timeout timer, and an abort-rejection promise are
 * wired synchronously at submission time, so timeout/suspend/stop take effect
 * even when the executor attaches its own abort listener afterwards (an
 * `abort` listener attached to an already-aborted signal never fires).
 */
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
  // signature plus the runtime guards in claimAndRun() keep JS/host callers
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
    if (!this.started || this.draining) {
      return Promise.reject(
        new Error('Cron coordinator is not accepting submissions (not started or draining)'),
      )
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
    const submission: PendingSubmission = { abort, promise: null as never }
    this.pending.add(submission)
    const promise = this.claimAndRun(task, scheduledFireTime, trigger, dedupKey, {
      abort,
      abortPromise,
      timeoutHandle,
      submission,
    })
    submission.promise = promise
    return promise
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

  private async claimAndRun(
    task: CronTask,
    scheduledFireTime: number,
    trigger: CronExecutionTrigger,
    dedupKey: string | undefined,
    handles: SubmissionHandles,
  ): Promise<CronExecution> {
    let claim: Awaited<ReturnType<ExecutionStore['claim']>>
    try {
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
      claim = await this.deps.executionStore.claim(claimInput)
    } catch (err) {
      // A rejected claim must not leak the submission: perform the same
      // cleanup as the non-claimed path below, otherwise stop()/suspend()
      // would later abort the leaked abortPromise with no handler attached
      // (unhandled CronExecutionInterruptedError).
      this.deps.timer.clearTimeout(handles.timeoutHandle)
      this.pending.delete(handles.submission)
      throw err
    }
    if (claim.kind !== 'claimed') {
      this.deps.timer.clearTimeout(handles.timeoutHandle)
      this.pending.delete(handles.submission)
      return claim.execution
    }
    return this.run(task, claim.execution, handles)
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

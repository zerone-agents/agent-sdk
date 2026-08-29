import { computeNextCronRun, parseCronExpression } from './cron.js'
import { systemClock, systemTimer, type CronClock, type CronTimer } from './clock.js'
import {
  CronExecutionCoordinator,
  dispatchCronSubmission,
} from './coordinator.js'
import {
  consoleDiagnosticSink,
  emitCronEvent,
  noopEventSink,
  reportCronDiagnostic,
  type CronDiagnosticSink,
  type CronEventSink,
} from './events.js'
import type { ExecutionStore } from './execution-store.js'
import type { CronExecutor } from './executor.js'
import { CronRuntime } from './runtime.js'
import { CronScheduler } from './scheduler.js'
import type { CronStorage } from './storage.js'
import type {
  CreateCronTaskInput,
  CronExecution,
  CronExecutionQuery,
  CronJitterConfig,
  CronTask,
  CronTaskChanges,
} from './types.js'

export const DEFAULT_MAX_CRON_TASKS = 50

/**
 * The single entry point for SDK-standard cron operations — shared by SDK
 * Tools and host APIs (issue #42). Host-only management APIs (runNow,
 * enqueueNow, get, update, listExecutions, getExecution) are NOT Agent Tools.
 *
 * Lifecycle (issue #57): `stop()` owns a service-operation barrier. Once
 * shutdown begins, the protected operations (`create`, `update`, `delete`,
 * `runNow`, `enqueueNow`) reject with {@link CronServiceStoppingError} —
 * during `stopping` and after a shutdown stop, when the directory lock has
 * been released and a storage write would be lock-unsafe. Before the first
 * `start()` and after a failed start, protected operations remain available
 * (setup/recovery flows, as in earlier versions). Already-entered protected
 * operations settle BEFORE the directory lock is released; scheduler intake
 * stops immediately at `stop()` call time, independent of slow operations.
 * Read-only methods (`list`, `get`, `listExecutions`, `getExecution`)
 * remain available in every lifecycle state and reflect the latest settled
 * state.
 */
export interface CronService {
  start(): Promise<void>
  stop(options?: { drainMs?: number }): Promise<void>
  suspend(): Promise<void>
  resume(): Promise<void>

  create(input: CreateCronTaskInput): Promise<CronTask>
  list(): Promise<CronTask[]>
  get(taskId: string): Promise<CronTask | null>
  update(taskId: string, changes: CronTaskChanges): Promise<CronTask | null>
  delete(taskId: string): Promise<void>
  runNow(taskId: string): Promise<CronExecution>
  /**
   * Submit a manual execution and return after its claim is durable
   * (issue #51): the initial `pending` record, the persisted `skipped`
   * record when the task already has an active execution, or the existing
   * record for a duplicate. The execution continues in the background under
   * the same coordinator and state machine as scheduled runs and `runNow`.
   * Host API — not an Agent Tool.
   */
  enqueueNow(taskId: string): Promise<CronExecution>

  listExecutions(query?: CronExecutionQuery): Promise<CronExecution[]>
  getExecution(executionId: string): Promise<CronExecution | null>
}

/** Service lifecycle phases; `stopping` exists between `stop()` entry and lock release. */
export type CronServicePhase = 'stopped' | 'running' | 'suspended' | 'stopping'

/**
 * Stable typed rejection for protected CronService operations after shutdown
 * begins (or before the service has started): hosts map this to a
 * machine-readable response such as HTTP `503 shutting_down`.
 */
export class CronServiceStoppingError extends Error {
  readonly method: string
  readonly phase: CronServicePhase
  constructor(method: string, phase: CronServicePhase) {
    super(
      `Cron service is ${phase === 'stopping' ? 'shutting down' : `not accepting operations (${phase})`}` +
        ` — ${method} rejected (issue #57 lifecycle barrier)`,
    )
    this.name = 'CronServiceStoppingError'
    this.method = method
    this.phase = phase
  }
}

/** Port: single-writer directory lock, acquired on start(), released on stop(). */
export interface CronRuntimeLock {
  acquire(): Promise<void>
  release(): Promise<void>
}

export interface CreateCronServiceOptions {
  taskStorage: CronStorage
  executionStore: ExecutionStore
  executor: CronExecutor
  events?: CronEventSink
  /** Diagnostics channel: sink/replay failures reported here, never thrown. */
  onDiagnostic?: CronDiagnosticSink
  executionTimeoutMs?: number
  maxTasks?: number
  clock?: CronClock
  timer?: CronTimer
  jitterConfig?: Partial<CronJitterConfig>
  lock?: CronRuntimeLock
}

function assertValidCronSpec(cron: string, clock: CronClock): void {
  const fields = parseCronExpression(cron)
  if (!fields) {
    throw new Error(
      `Invalid cron expression: "${cron}". Must be a valid 5-field cron (e.g. "0 16 * * *").`,
    )
  }
  const next = computeNextCronRun(fields, new Date(clock.now()))
  if (!next) {
    throw new Error(`Cron expression has no matching run time within 366 days: ${cron}`)
  }
}

export function createCronService(options: CreateCronServiceOptions): CronService {
  const {
    taskStorage,
    executionStore,
    executor,
    executionTimeoutMs,
    clock = systemClock,
    timer = systemTimer,
    events = noopEventSink,
    maxTasks = DEFAULT_MAX_CRON_TASKS,
  } = options
  const onDiagnostic = options.onDiagnostic ?? consoleDiagnosticSink

  // Wrap the sink once so EVERY emit — the coordinator's and the service's
  // own — reports sink failures through the diagnostics channel instead of
  // swallowing them silently. Diagnostics never reject or alter state.
  const safeEvents: CronEventSink = (event) => emitCronEvent(events, event, onDiagnostic)

  const coordinator = new CronExecutionCoordinator({
    executionStore,
    executor,
    storage: taskStorage,
    clock,
    timer,
    events: safeEvents,
    executionTimeoutMs,
  })
  const scheduler = new CronScheduler({
    storage: taskStorage,
    clock,
    timer,
    host: {
      onFire: async (task, scheduledFireTime) => {
        // Fire-and-forget for scheduled triggers: the scheduler's timer loop
        // must never depend on execution duration (a hung executor with a
        // 30-minute timeout would stall every other task's schedule). Per-task
        // serialization is already the ExecutionStore's job (claim / skipped /
        // duplicate). runNow still awaits submit() for its final status.
        void coordinator
          .submit(task, scheduledFireTime, 'scheduled')
          .catch((err) => {
            // Best-effort: a throwing diagnostics sink must not turn this
            // detached handler into an unhandled rejection.
            reportCronDiagnostic(
              onDiagnostic,
              `scheduled submit failed for ${task.id}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            )
          })
      },
    },
    jitterConfig: options.jitterConfig,
  })
  const runtime = new CronRuntime({ scheduler, coordinator })

  // --- Service-operation barrier (issue #57) -------------------------------
  // `stop()` owns this lifecycle: protected operations (create/update/delete/
  // runNow/enqueueNow) may only enter while running or suspended; shutdown
  // rejects them with CronServiceStoppingError and waits for the
  // already-entered ones to settle before releasing the directory lock.
  let phase: CronServicePhase = 'stopped'
  /** Set by stop() and cleared by a successful start(): distinguishes "stopped by shutdown" (protected ops reject — the directory lock was released by stop) from "not started yet / start failed" (protected ops stay available for setup and recovery flows, as in earlier versions). */
  let stoppedByShutdown = false
  let inflight = 0
  let inflightIdle: (() => void) | null = null
  let stopPromise: Promise<void> | null = null

  function assertAccepting(method: string): void {
    if (phase === 'stopping' || (phase === 'stopped' && stoppedByShutdown)) {
      throw new CronServiceStoppingError(method, phase)
    }
  }

  /**
   * Entry into a protected operation. The check + increment live in the
   * synchronous prefix, so entry is atomic with respect to stop()'s
   * synchronous `phase = 'stopping'` transition: an operation invoked before
   * stop() is counted; one invoked after is rejected.
   */
  async function guarded<T>(method: string, fn: () => Promise<T>): Promise<T> {
    assertAccepting(method)
    inflight += 1
    try {
      return await fn()
    } finally {
      inflight -= 1
      if (inflight === 0 && inflightIdle !== null) {
        const resolve = inflightIdle
        inflightIdle = null
        resolve()
      }
    }
  }

  function waitForInflight(): Promise<void> {
    if (inflight === 0) return Promise.resolve()
    return new Promise<void>((resolve) => {
      inflightIdle = resolve
    })
  }
  // --------------------------------------------------------------------------

  const emitSchedule = () =>
    emitCronEvent(events, { type: 'scheduleUpdated', snapshots: scheduler.snapshot() }, onDiagnostic)

  return {
    async start(): Promise<void> {
      // Shutdown is one-way: no lifecycle transition may reopen operations
      // while a stop is draining (issue #57).
      if (phase === 'stopping') throw new CronServiceStoppingError('start', phase)
      // Idempotent start: a second start() while running (or suspended) must
      // be a no-op. Without this guard, a failed re-acquire of the runtime
      // lock would hit the catch below and RELEASE the still-live lock,
      // letting a second process start on the same directory.
      if (phase !== 'stopped') return
      try {
        await options.lock?.acquire()
        await runtime.start()
        phase = 'running'
        stoppedByShutdown = false
        await emitSchedule()
      } catch (err) {
        // Release the lock on any start failure so a retry is not deadlocked.
        await options.lock?.release().catch(() => {})
        throw err
      }
    },

    async stop(options2?: { drainMs?: number }): Promise<void> {
      // Idempotent: a stop() after a full stop is a no-op.
      if (phase === 'stopped') return
      // Concurrent stop() calls observe the SAME completion/error outcome.
      if (phase === 'stopping') {
        await stopPromise!
        return
      }
      phase = 'stopping'
      const stopping = (async () => {
        // runtime.stop()'s synchronous first step is scheduler.stop(), so
        // scheduler intake stops DETERMINISTICALLY at stop()-call time —
        // never delayed by the operations drained below. The coordinator's
        // drainMs/interrupt phase runs CONCURRENTLY with the barrier: a
        // hung protected operation (e.g. a runNow awaiting a hung execution)
        // is settled by the interrupt phase, which then clears the barrier —
        // waiting for it strictly before the drain would deadlock.
        const runtimeStop = runtime.stop(options2)
        // Interim unhandled guard: the error (if any) re-surfaces at the
        // await below, even if the barrier drains for a long time.
        runtimeStop.catch(() => {})
        try {
          await waitForInflight()
          await runtimeStop
        } finally {
          phase = 'stopped'
          stoppedByShutdown = true
          stopPromise = null
          await options.lock?.release().catch(() => {})
        }
      })()
      stopPromise = stopping
      return stopping
    },

    suspend: async () => {
      assertAccepting('suspend')
      await runtime.suspend()
      // A concurrent stop() may have transitioned to 'stopping' while the
      // runtime call was in flight — never clobber it.
      if (phase === 'running') phase = 'suspended'
    },

    resume: async () => {
      assertAccepting('resume')
      await runtime.resume()
      if (phase === 'suspended') phase = 'running'
    },

    async create(input: CreateCronTaskInput): Promise<CronTask> {
      return guarded('create', async () => {
        assertValidCronSpec(input.cron, clock)
        const tasks = await taskStorage.load()
        if (tasks.length >= maxTasks) {
          throw new Error(`Cron task limit reached: maximum ${maxTasks} tasks.`)
        }
        const task = await taskStorage.add({
          cron: input.cron,
          prompt: input.prompt,
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
        })
        await scheduler.refresh()
        await emitCronEvent(events, { type: 'taskCreated', task }, onDiagnostic)
        await emitSchedule()
        return task
      })
    },

    list: () => taskStorage.load(),
    get: (taskId: string) => taskStorage.get(taskId),

    async update(taskId: string, changes: CronTaskChanges): Promise<CronTask | null> {
      return guarded('update', async () => {
        if (changes.cron !== undefined) assertValidCronSpec(changes.cron, clock)
        const updated = await taskStorage.update(taskId, changes)
        if (!updated) return null
        await scheduler.refresh()
        await emitCronEvent(events, { type: 'taskUpdated', task: updated }, onDiagnostic)
        await emitSchedule()
        return updated
      })
    },

    async delete(taskId: string): Promise<void> {
      return guarded('delete', async () => {
        const existing = await taskStorage.get(taskId)
        if (!existing) throw new Error(`Cron task not found: ${taskId}`)
        await taskStorage.remove([taskId])
        await scheduler.refresh()
        await emitCronEvent(events, { type: 'taskDeleted', taskId }, onDiagnostic)
        await emitSchedule()
      })
    },

    async runNow(taskId: string): Promise<CronExecution> {
      return guarded('runNow', async () => {
        const task = await taskStorage.get(taskId)
        if (!task) throw new Error(`Cron task not found: ${taskId}`)
        // Identity is a unique dedup key, NOT a synthetic fire time: the real
        // clock timestamp stays accurate (no drift on frozen/rapid calls), and
        // a uuid guarantees distinct executions even within the same
        // millisecond (concurrent triggers record `skipped`, not `duplicate`).
        // `globalThis.crypto` is the WebCrypto global (Node >= 19) — no
        // `node:` import so the kernel stays portable.
        return coordinator.submit(
          task,
          clock.now(),
          'manual',
          `manual:${globalThis.crypto.randomUUID()}`,
        )
      })
    },

    async enqueueNow(taskId: string): Promise<CronExecution> {
      return guarded('enqueueNow', async () => {
        const task = await taskStorage.get(taskId)
        if (!task) throw new Error(`Cron task not found: ${taskId}`)
        // Claim-returning manual trigger (issue #51): same identity rules as
        // runNow(); resolves once the claim is durable while the coordinator
        // continues the execution in the background. Reached through the
        // SDK-internal split — the public coordinator surface keeps only
        // submit().
        const submitted = dispatchCronSubmission(
          coordinator,
          task,
          clock.now(),
          'manual',
          `manual:${globalThis.crypto.randomUUID()}`,
        )
        // Observe the detached completion through the diagnostics policy —
        // never an unhandled rejection (same contract as the scheduler's
        // fire-and-forget submissions).
        submitted.completion.catch((err) => {
          reportCronDiagnostic(
            onDiagnostic,
            `enqueued execution failed for ${task.id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          )
        })
        return submitted.claimed
      })
    },

    listExecutions: (query?: CronExecutionQuery) => executionStore.list(query),
    getExecution: (executionId: string) => executionStore.get(executionId),
  }
}

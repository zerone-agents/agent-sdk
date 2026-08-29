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

/**
 * Service lifecycle phases. `starting` and `stopping` are the transient
 * barriers: a shared start/stop promise linearizes concurrent lifecycle
 * calls, and `stopping` persists through lock release (and beyond, on a
 * release failure) so shutdown's lock boundary is never observable early.
 */
export type CronServicePhase = 'stopped' | 'starting' | 'running' | 'suspended' | 'stopping'

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
        // Intake boundary at stop()-call time (review on PR #58): the
        // synchronous stopping intent drops EVERY scheduled submission —
        // including restart/resume catch-up fires racing a queued stop —
        // regardless of the scheduler's internal arming state. The
        // serialized stop body then stops the scheduler itself.
        if (stoppingIntent) return
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
  let startPromise: Promise<void> | null = null
  /**
   * Shutdown INTENT, published in stop()'s synchronous prefix (review on
   * PR #58): from stop()-call time — even while an in-flight start/resume
   * body is still settling — protected operations reject and the onFire
   * submission boundary drops every scheduled fire (including restart and
   * resume catch-ups). The serialized stop body then stops the scheduler
   * itself. Cleared when shutdown settles successfully (or a waited-out
   * start failed and left nothing to stop) so restarts work; retained on a
   * failed lock release (the wedged, non-accepting state).
   */
  let stoppingIntent = false

  /**
   * Lifecycle serialization (review on PR #58): the start/stop/suspend/
   * resume BODIES run on one chain, so stop always owns the FINAL runtime
   * transition — a suspend/resume entered just before stop cannot complete
   * after it and overwrite the runtime's stopped state. Entry checks and
   * phase transitions stay synchronous at call time; only the awaited bodies
   * serialize. While any body is mid-flight the scheduler is inert (not yet
   * started, suspended, or being stopped), so stop()'s immediate-intake
   * guarantee is preserved even when its body is briefly queued.
   */
  let lifecycleChain: Promise<unknown> = Promise.resolve()
  function enqueueLifecycle<T>(fn: () => Promise<T>): Promise<T> {
    const run = lifecycleChain.then(fn, fn)
    lifecycleChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  function assertAccepting(method: string): void {
    if (
      stoppingIntent ||
      phase === 'stopping' ||
      (phase === 'stopped' && stoppedByShutdown)
    ) {
      throw new CronServiceStoppingError(method, stoppingIntent || phase === 'stopping' ? 'stopping' : phase)
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
      // Shutdown is one-way and starts at stop()-CALL time: the synchronous
      // intent rejects lifecycle transitions even while an in-flight start
      // is still settling (joining that start and reporting success would
      // reopen the lifecycle behind a pending shutdown — review on PR #58).
      if (stoppingIntent) throw new CronServiceStoppingError('start', 'stopping')
      // Concurrent start() calls observe the SAME outcome as the in-flight
      // one (shared start promise — review on PR #58).
      if (phase === 'starting') {
        await startPromise!
        return
      }
      // Idempotent start: a second start() while running (or suspended) must
      // be a no-op. (Historic guard rationale: a failed re-acquire must not
      // release a still-live lock.)
      if (phase !== 'stopped') return
      phase = 'starting'
      const starting = enqueueLifecycle(async () => {
        try {
          await options.lock?.acquire()
          await runtime.start()
          phase = 'running'
          stoppedByShutdown = false
          await emitSchedule()
        } catch (err) {
          // Release BEFORE flipping the phase back so callers awaiting this
          // promise cannot enter between the release and the phase write
          // (a concurrent start must not acquire against a pending release).
          await options.lock?.release().catch(() => {})
          phase = 'stopped'
          throw err
        } finally {
          startPromise = null
        }
      })
      startPromise = starting
      return starting
    },

    async stop(options2?: { drainMs?: number }): Promise<void> {
      // Idempotent: a stop() after a fully settled stop is a no-op.
      if (phase === 'stopped') return
      // Shutdown INTENT is published SYNCHRONOUSLY, before any await: from
      // this call-time boundary, protected operations reject and the onFire
      // submission boundary drops scheduled fires — even while an in-flight
      // start/resume body is still settling (review on PR #58). The actual
      // runtime stop linearizes below.
      stoppingIntent = true
      // Concurrent stop() calls observe the SAME completion/error outcome —
      // including while the lock release is still pending (review on PR #58:
      // 'stopped' must never be observable before the release settles).
      if (phase === 'stopping') {
        await stopPromise!
        return
      }
      if (phase === 'starting') {
        // Linearize AFTER the in-flight start (same outcome): if it reached
        // running, proceed with the shutdown; a failed start left nothing
        // to stop (its catch already released the lock). If another stop
        // won the race meanwhile, observe its outcome instead.
        await startPromise!.then(
          () => undefined,
          () => undefined,
        )
        // The cast re-widens the type: TS's narrowing from the outer
        // `phase === 'starting'` check survives the await, but the start
        // body HAS meanwhile written the real phase (running/stopped).
        const phaseNow = phase as CronServicePhase
        if (phaseNow === 'stopping') {
          await stopPromise!
          return
        }
        if (phaseNow !== 'running') {
          // The start failed and released its lock: nothing to stop. Clear
          // the intent so the service stays restartable.
          stoppingIntent = false
          return
        }
      }
      phase = 'stopping'
      const stopping = enqueueLifecycle(async () => {
        // runtime.stop()'s synchronous first step is scheduler.stop(), so
        // scheduler intake stops as soon as this (serialized) body runs.
        // OBSERVE THE RUNTIME STOP FIRST (review on PR #58): its bounded
        // drain/interrupt phase settles every execution-backed protected
        // operation (a hung runNow is interrupted after drainMs), while an
        // early failure — one thrown BEFORE it could interrupt — surfaces
        // PROMPTLY; awaiting the operation barrier first would hide that
        // known failure behind a hung operation forever (all stop callers
        // pending on a rejection that already happened). Awaiting the
        // runtime stop first is deadlock-free: the drain is bounded by
        // drainMs and pure CRUD operations never block it.
        let runtimeStopped = false
        try {
          await runtime.stop(options2)
          runtimeStopped = true
          // Execution-backed operations settled above; only pure CRUD
          // operations (e.g. a slow storage write) can remain — they must
          // truly settle before the lock boundary (issue #57).
          await waitForInflight()
        } finally {
          // Only a PROVEN-SAFE runtime stop may settle the lock boundary:
          // if the runtime stop rejected (e.g. a failing Timer/storage
          // port), the coordinator may be unsafely settled and the
          // runtime's internal state is stale — releasing the lock or
          // publishing a clean 'stopped' would let a restart no-op against
          // it (review on PR #58). The failure-convergence path: stop()
          // rejects with the runtime error and the service stays
          // non-accepting with the single-writer lock HELD (phase
          // 'stopping', stopPromise and intent retained) until manual
          // intervention.
          if (runtimeStopped) {
            // Issue #57's required order: settle entered ops → stop the
            // runtime → release the lock → ONLY THEN publish stopped. The
            // release is part of the shared stop outcome: a release failure
            // rejects stop() and equally leaves the service non-accepting —
            // never a clean 'stopped' on a failed lock boundary.
            await options.lock?.release()
            phase = 'stopped'
            stoppedByShutdown = true
            stopPromise = null
            // Shutdown settled cleanly: the intake intent has done its job —
            // clear it so a restart fires normally again.
            stoppingIntent = false
          }
        }
      })
      stopPromise = stopping
      return stopping
    },

    suspend: async () => {
      assertAccepting('suspend')
      return enqueueLifecycle(async () => {
        // A stop may have transitioned while this body was queued: abandon
        // rather than overwrite the runtime's final state.
        if (phase === 'stopping' || phase === 'stopped') return
        await runtime.suspend()
        // A concurrent stop() may have transitioned to 'stopping' while the
        // runtime call was in flight — never clobber it.
        if (phase === 'running') phase = 'suspended'
      })
    },

    resume: async () => {
      assertAccepting('resume')
      return enqueueLifecycle(async () => {
        if (phase !== 'suspended') return
        await runtime.resume()
        if (phase === 'suspended') phase = 'running'
      })
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

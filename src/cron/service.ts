import { computeNextCronRun, parseCronExpression } from './cron.js'
import { systemClock, systemTimer, type CronClock, type CronTimer } from './clock.js'
import { CronExecutionCoordinator } from './coordinator.js'
import {
  consoleDiagnosticSink,
  emitCronEvent,
  noopEventSink,
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
 * Tools and host APIs (issue #42). Host-only management APIs (runNow, get,
 * update, listExecutions, getExecution) are NOT Agent Tools.
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

  listExecutions(query?: CronExecutionQuery): Promise<CronExecution[]>
  getExecution(executionId: string): Promise<CronExecution | null>
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
            onDiagnostic(
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

  // Monotonic manual fire time: guarantees distinct (taskId, scheduledFireTime)
  // dedup keys even when runNow is called twice within the same millisecond
  // (or on a frozen test clock), so concurrent triggers record `skipped`
  // instead of collapsing into a `duplicate` with an inconsistent snapshot.
  let lastManualFireAt = 0

  const emitSchedule = () =>
    emitCronEvent(events, { type: 'scheduleUpdated', snapshots: scheduler.snapshot() }, onDiagnostic)

  return {
    async start(): Promise<void> {
      // Idempotent start: a second start() while running (or suspended) must
      // be a no-op. Without this guard, a failed re-acquire of the runtime
      // lock would hit the catch below and RELEASE the still-live lock,
      // letting a second process start on the same directory.
      if (runtime.getState() !== 'stopped') return
      try {
        await options.lock?.acquire()
        await runtime.start()
        await emitSchedule()
      } catch (err) {
        // Release the lock on any start failure so a retry is not deadlocked.
        await options.lock?.release().catch(() => {})
        throw err
      }
    },

    async stop(options2?: { drainMs?: number }): Promise<void> {
      await runtime.stop(options2)
      await options.lock?.release().catch(() => {})
    },

    suspend: () => runtime.suspend(),
    resume: () => runtime.resume(),

    async create(input: CreateCronTaskInput): Promise<CronTask> {
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
    },

    list: () => taskStorage.load(),
    get: (taskId: string) => taskStorage.get(taskId),

    async update(taskId: string, changes: CronTaskChanges): Promise<CronTask | null> {
      if (changes.cron !== undefined) assertValidCronSpec(changes.cron, clock)
      const updated = await taskStorage.update(taskId, changes)
      if (!updated) return null
      await scheduler.refresh()
      await emitCronEvent(events, { type: 'taskUpdated', task: updated }, onDiagnostic)
      await emitSchedule()
      return updated
    },

    async delete(taskId: string): Promise<void> {
      const existing = await taskStorage.get(taskId)
      if (!existing) throw new Error(`Cron task not found: ${taskId}`)
      await taskStorage.remove([taskId])
      await scheduler.refresh()
      await emitCronEvent(events, { type: 'taskDeleted', taskId }, onDiagnostic)
      await emitSchedule()
    },

    async runNow(taskId: string): Promise<CronExecution> {
      // Capture the manual fire time eagerly (at invocation) and keep it
      // strictly monotonic across manual triggers, so a task invoked twice
      // (even in the same millisecond) gets two distinct fire times rather
      // than a duplicate.
      const fireTime = Math.max(clock.now(), lastManualFireAt + 1)
      lastManualFireAt = fireTime
      const task = await taskStorage.get(taskId)
      if (!task) throw new Error(`Cron task not found: ${taskId}`)
      return coordinator.submit(task, fireTime, 'manual')
    },

    listExecutions: (query?: CronExecutionQuery) => executionStore.list(query),
    getExecution: (executionId: string) => executionStore.get(executionId),
  }
}

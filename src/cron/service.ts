import { computeNextCronRun, parseCronExpression } from './cron.js'
import { systemClock, systemTimer, type CronClock, type CronTimer } from './clock.js'
import { CronExecutionCoordinator } from './coordinator.js'
import { emitCronEvent, noopEventSink, type CronEventSink } from './events.js'
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
  executionTimeoutMs?: number
  maxTasks?: number
  clock?: CronClock
  timer?: CronTimer
  jitterConfig?: Partial<CronJitterConfig>
  lock?: CronRuntimeLock
}

function assertValidCronSpec(cron: string): void {
  const fields = parseCronExpression(cron)
  if (!fields) {
    throw new Error(
      `Invalid cron expression: "${cron}". Must be a valid 5-field cron (e.g. "0 16 * * *").`,
    )
  }
  const next = computeNextCronRun(fields, new Date())
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

  const coordinator = new CronExecutionCoordinator({
    executionStore,
    executor,
    storage: taskStorage,
    clock,
    timer,
    events,
    executionTimeoutMs,
  })
  const scheduler = new CronScheduler({
    storage: taskStorage,
    clock,
    timer,
    host: {
      onFire: async (task, scheduledFireTime) => {
        await coordinator.submit(task, scheduledFireTime, 'scheduled')
      },
    },
    jitterConfig: options.jitterConfig,
  })
  const runtime = new CronRuntime({ scheduler, coordinator })

  const emitSchedule = () =>
    emitCronEvent(events, { type: 'scheduleUpdated', snapshots: scheduler.snapshot() })

  return {
    async start(): Promise<void> {
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
      assertValidCronSpec(input.cron)
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
      await emitCronEvent(events, { type: 'taskCreated', task })
      await emitSchedule()
      return task
    },

    list: () => taskStorage.load(),
    get: (taskId: string) => taskStorage.get(taskId),

    async update(taskId: string, changes: CronTaskChanges): Promise<CronTask | null> {
      if (changes.cron !== undefined) assertValidCronSpec(changes.cron)
      const updated = await taskStorage.update(taskId, changes)
      if (!updated) return null
      await scheduler.refresh()
      await emitCronEvent(events, { type: 'taskUpdated', task: updated })
      await emitSchedule()
      return updated
    },

    async delete(taskId: string): Promise<void> {
      const existing = await taskStorage.get(taskId)
      if (!existing) throw new Error(`Cron task not found: ${taskId}`)
      await taskStorage.remove([taskId])
      await scheduler.refresh()
      await emitCronEvent(events, { type: 'taskDeleted', taskId })
      await emitSchedule()
    },

    async runNow(taskId: string): Promise<CronExecution> {
      // Capture the manual fire time eagerly (at invocation), so a task
      // invoked twice gets two distinct fire times rather than a duplicate.
      const fireTime = clock.now()
      const task = await taskStorage.get(taskId)
      if (!task) throw new Error(`Cron task not found: ${taskId}`)
      return coordinator.submit(task, fireTime, 'manual')
    },

    listExecutions: (query?: CronExecutionQuery) => executionStore.list(query),
    getExecution: (executionId: string) => executionStore.get(executionId),
  }
}

import path from 'node:path'

import type {
  CronExecution,
  CronExecutionQuery,
  CronTask,
  CreateCronTaskInput,
  CronTaskChanges,
} from '../types.js'
import type { CronExecutor } from '../executor.js'
import { createCronService } from '../service.js'
import { consoleDiagnosticSink } from '../events.js'
import { FileCronStorage } from './file-storage.js'
import { FileExecutionStore } from './file-execution-store.js'
import { acquireRuntimeLock } from './lock.js'
import { defaultCronDataDir } from './default.js'

/**
 * Read/write CRUD and execution-history access for offline Cron management
 * (issue #52). Deliberately narrower than {@link CronService}: no
 * start/stop/suspend/resume, no runNow/enqueueNow — a maintenance session
 * never runs a Scheduler, timer, or Agent executor, and never performs
 * startup recovery (`pending`/`running` → `interrupted` stays owned by the
 * real Runtime's start()).
 */
export interface CronMaintenanceService {
  create(input: CreateCronTaskInput): Promise<CronTask>
  list(): Promise<CronTask[]>
  get(taskId: string): Promise<CronTask | null>
  update(taskId: string, changes: CronTaskChanges): Promise<CronTask | null>
  delete(taskId: string): Promise<void>

  listExecutions(query?: CronExecutionQuery): Promise<CronExecution[]>
  getExecution(executionId: string): Promise<CronExecution | null>
}

export interface CronMaintenanceSessionOptions {
  /**
   * Root data directory; cron state lives under `<dataDir>/cron/`. Same
   * meaning as {@link createDefaultCronService}; defaults to `~/.agents`.
   */
  dataDir?: string
}

/**
 * Executor that can never run: maintenance never executes agents. The
 * coordinator path is unreachable without start()/runNow/enqueueNow — this
 * makes any accidental invocation loud instead of silent.
 */
const neverExecutor: CronExecutor = async () => {
  throw new Error('Cron maintenance sessions never execute agents (issue #52).')
}

/**
 * Open a short-lived, exclusively locked Cron maintenance session over the
 * same directory a default CronService would run in (issue #52).
 *
 * Semantics:
 * - Acquires the exact same `<dataDir>/cron/runtime.lock` the online
 *   Runtime's `start()` takes (same module, same stale-owner policy — no
 *   second lock format). A held directory fails fast with the lock path
 *   named for manual cleanup.
 * - Task CRUD and history reads use the same file adapters and the same
 *   validation/mutation code paths as the normal service (the internal
 *   service is composed but NEVER started: its scheduler is inert before
 *   start(), recovery lives in runtime.start(), and the executor is a
 *   throw-on-call stub).
 * - The lock is released when the callback settles — including on
 *   rejection — after any still-in-flight operation has settled, and any
 *   partially initialized resource is cleaned up.
 * - A service reference retained past the session refuses every operation.
 *
 * The callback scoping makes lock ownership explicit: callers cannot
 * accidentally hold the directory after the session ends.
 */
export async function withCronMaintenanceSession<T>(
  options: CronMaintenanceSessionOptions,
  use: (service: CronMaintenanceService) => Promise<T>,
): Promise<T> {
  const cronDir = path.join(options.dataDir ?? defaultCronDataDir(), 'cron')

  // Same single-writer lock as the online Runtime (O_EXCL): a running
  // Runtime or another maintenance session makes this reject immediately.
  const lock = await acquireRuntimeLock(cronDir)

  // Session lifetime guard: flipped in the release path below. Every
  // method consults it, so a reference retained past the callback cannot
  // operate against a released lock.
  let closed = false
  // In-flight bookkeeping (same pattern as the service's operation
  // barrier): operations the callback fired but did not await still settle
  // BEFORE the lock is released — an unawaited write must never race a
  // subsequently started Runtime.
  let inflight = 0
  let inflightIdle: (() => void) | null = null

  function waitForInflight(): Promise<void> {
    if (inflight === 0) return Promise.resolve()
    return new Promise<void>((resolve) => {
      inflightIdle = resolve
    })
  }

  function guarded<T>(method: string, fn: () => Promise<T>): Promise<T> {
    if (closed) {
      return Promise.reject(
        new Error(
          `Cron maintenance session has ended — ${method} refused ` +
            '(the directory lock was released; issue #52).',
        ),
      )
    }
    inflight += 1
    return fn().finally(() => {
      inflight -= 1
      if (inflight === 0 && inflightIdle !== null) {
        const resolve = inflightIdle
        inflightIdle = null
        resolve()
      }
    })
  }

  try {
    // Same adapters and the same service code paths as
    // createDefaultCronService — but composed WITHOUT a lock (this session
    // already owns it) and NEVER started. Consequences of "never started":
    // protected CRUD stays available (the pre-start state is the documented
    // setup window), scheduler.refresh()/snapshot() are inert no-ops before
    // start(), and no recovery/timer/executor lifecycle ever runs.
    const internal = createCronService({
      taskStorage: new FileCronStorage(cronDir),
      executionStore: new FileExecutionStore(cronDir, {
        onDiagnostic: consoleDiagnosticSink,
      }),
      executor: neverExecutor,
    })

    const service: CronMaintenanceService = {
      create: (input) => guarded('create', () => internal.create(input)),
      list: () => guarded('list', () => internal.list()),
      get: (taskId) => guarded('get', () => internal.get(taskId)),
      update: (taskId, changes) =>
        guarded('update', () => internal.update(taskId, changes)),
      delete: (taskId) => guarded('delete', () => internal.delete(taskId)),
      listExecutions: (query) =>
        guarded('listExecutions', () => internal.listExecutions(query)),
      getExecution: (executionId) =>
        guarded('getExecution', () => internal.getExecution(executionId)),
    }

    return await use(service)
  } finally {
    // Close FIRST: no new operation may enter once the callback settled;
    // then let already-entered operations settle before the lock boundary
    // (mirrors the service's stop() ordering: settle ops → release lock).
    closed = true
    await waitForInflight()
    await lock.release()
  }
}

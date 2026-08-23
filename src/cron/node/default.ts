import path from 'node:path'

import type { Agent } from '../../agent.js'
import type { AgentOptions } from '../../types.js'
import type { CronClock, CronTimer } from '../clock.js'
import type { CronEventSink } from '../events.js'
import { createDefaultAgentCronExecutor, type CronAgentResolver } from '../executor.js'
import { createCronService, type CronRuntimeLock, type CronService } from '../service.js'
import type { CronJitterConfig } from '../types.js'
import { FileCronStorage } from './file-storage.js'
import { FileExecutionStore } from './file-execution-store.js'
import { acquireRuntimeLock } from './lock.js'

export interface CreateDefaultCronServiceOptions {
  /** Root data directory; cron state lives under `<dataDir>/cron/`. */
  dataDir: string
  /** Resolves the CURRENT agent definition on every fire (issue #42). */
  resolveAgent: CronAgentResolver
  /** Test seam for DefaultAgentCronExecutor; defaults to the real createAgent. */
  createAgentFn?: (options: AgentOptions) => Agent
  executionTimeoutMs?: number
  events?: CronEventSink
  maxTasks?: number
  clock?: CronClock
  timer?: CronTimer
  jitterConfig?: Partial<CronJitterConfig>
}

/**
 * Composes the default runtime: file storage + file execution store +
 * DefaultAgentCronExecutor + directory lock. `start()` acquires
 * `<dataDir>/cron/runtime.lock` (issue #42: lock is taken during start),
 * `stop()` drains and releases it.
 */
export function createDefaultCronService(
  options: CreateDefaultCronServiceOptions,
): CronService {
  const cronDir = path.join(options.dataDir, 'cron')
  const taskStorage = new FileCronStorage(cronDir)
  const executionStore = new FileExecutionStore(cronDir)
  const executor = createDefaultAgentCronExecutor(
    options.resolveAgent,
    options.createAgentFn ? { createAgentFn: options.createAgentFn } : undefined,
  )

  let lock: CronRuntimeLock | null = null
  return createCronService({
    taskStorage,
    executionStore,
    executor,
    events: options.events,
    executionTimeoutMs: options.executionTimeoutMs,
    maxTasks: options.maxTasks,
    clock: options.clock,
    timer: options.timer,
    jitterConfig: options.jitterConfig,
    lock: {
      acquire: async () => {
        // Idempotent: if we already hold the live lock, do not try to
        // re-acquire (O_EXCL would throw) and do not overwrite the closure
        // variable — a second acquire must leave the original lock intact.
        if (lock) return
        lock = await acquireRuntimeLock(cronDir)
      },
      release: async () => {
        await lock?.release()
        lock = null
      },
    },
  })
}

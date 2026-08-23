import type { CronExecutionTrigger, CronTask } from './types.js'

/**
 * Port: runs one scheduled task. Executors must respect the AbortSignal
 * (timeout / suspend / stop) and return the execution output. They never
 * manage scheduling or persistence.
 */
export type CronExecutor = (
  task: CronTask,
  context: {
    executionId: string
    trigger: CronExecutionTrigger
    signal: AbortSignal
  },
) => Promise<{ output?: string }>

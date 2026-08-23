import type { CronTask, CronTaskChanges } from './types.js'

/**
 * Port: persistence for cron task definitions.
 *
 * `load()` returns the CURRENTLY SCHEDULABLE task set — hosts express
 * enable/disable by omitting disabled tasks from the result (issue #42:
 * `enabled` is not part of the SDK task model). `nextRunAt` is derived
 * scheduler state and is never persisted here.
 */
export interface CronStorage {
  load(): Promise<CronTask[]>
  get(taskId: string): Promise<CronTask | null>
  /** Atomically persists and returns the task with generated id/createdAt. */
  add(task: Omit<CronTask, 'id' | 'createdAt'>): Promise<CronTask>
  /** Applies partial changes; returns null when the task does not exist. */
  update(taskId: string, changes: CronTaskChanges): Promise<CronTask | null>
  remove(ids: string[]): Promise<void>
  markFired(ids: string[], firedAt: number): Promise<void>
}

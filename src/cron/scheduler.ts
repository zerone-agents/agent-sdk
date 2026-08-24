import { jitteredNextCronRunMs } from './jitter.js'
import type { CronClock, CronTimer } from './clock.js'
import type { CronStorage } from './storage.js'
import type { CronJitterConfig, CronScheduleSnapshot, CronTask } from './types.js'

export interface CronSchedulerHost {
  onFire(task: CronTask, scheduledFireTime: number): void | Promise<void>
}

interface SchedulerEntry {
  task: CronTask
  fingerprint: string
  nextRunAt: number | null
}

function taskFingerprint(task: CronTask): string {
  return JSON.stringify([
    task.id,
    task.name ?? null,
    task.cron,
    task.prompt,
    task.agentId ?? null,
  ])
}

const MAX_CATCHUP_WALK = 100_000

/**
 * Schedules task fires. Knows nothing about executions or persistence of
 * run state: it computes jittered slots, diffs task snapshots by content
 * fingerprint, submits due slots to the host, and catches up at most the
 * most recent missed slot per task after downtime.
 */
export class CronScheduler {
  private entries = new Map<string, SchedulerEntry>()
  private timerHandle: unknown = null
  private started = false
  private suspended = false

  constructor(
    private readonly deps: {
      storage: CronStorage
      clock: CronClock
      timer: CronTimer
      host: CronSchedulerHost
      jitterConfig?: Partial<CronJitterConfig>
    },
  ) {}

  async start(): Promise<void> {
    this.started = true
    this.suspended = false
    await this.refresh()
    await this.catchUpAfterRestart()
  }

  /**
   * After a process restart (entries rebuilt from storage), each task's
   * missed-most-recent slot since its persisted anchor is submitted once.
   * The ExecutionStore's permanent (taskId, fireTime) dedup absorbs slots
   * that already executed before the downtime, so submitting is safe.
   */
  private async catchUpAfterRestart(): Promise<void> {
    const now = this.deps.clock.now()
    for (const entry of this.entries.values()) {
      const slot = this.mostRecentSlotSince(entry.task, now)
      if (slot === null) continue
      try {
        await this.deps.host.onFire(entry.task, slot)
      } catch {
        // Host (coordinator) errors never break the scheduling loop.
      }
      entry.nextRunAt = this.nextSlotAfter(entry.task, slot)
    }
  }

  /**
   * Most recent jittered slot in (anchor, now]; anchor = lastFiredAt ?? createdAt.
   * The walk is capped at MAX_CATCHUP_WALK; on cap exhaustion the task gives
   * up (no fire) — astronomically rare, and firing a stale slot would be worse.
   */
  private mostRecentSlotSince(task: CronTask, now: number): number | null {
    const anchor = task.lastFiredAt ?? task.createdAt
    let last: number | null = null
    let slot = this.nextSlotAfter(task, anchor)
    let guard = 0
    while (slot !== null && slot <= now && guard < MAX_CATCHUP_WALK) {
      last = slot
      slot = this.nextSlotAfter(task, slot)
      guard++
    }
    return last
  }

  stop(): void {
    this.started = false
    this.suspended = false
    this.clearTimer()
    this.entries.clear()
  }

  suspend(): void {
    if (!this.started || this.suspended) return
    this.suspended = true
    this.clearTimer()
  }

  async resume(): Promise<void> {
    if (!this.started || !this.suspended) return
    this.suspended = false
    await this.refresh()
    await this.catchUp()
    this.armTimer()
  }

  /** Reload tasks and diff by fingerprint; re-arm the wake timer. No-op while suspended or stopped. */
  async refresh(): Promise<void> {
    if (!this.started || this.suspended) return
    const tasks = await this.deps.storage.load()
    const seen = new Set<string>()
    for (const task of tasks) {
      seen.add(task.id)
      const fingerprint = taskFingerprint(task)
      const prev = this.entries.get(task.id)
      if (prev && prev.fingerprint === fingerprint) continue
      this.entries.set(task.id, {
        task,
        fingerprint,
        nextRunAt: this.computeNextRunAt(task),
      })
    }
    for (const id of [...this.entries.keys()]) {
      if (!seen.has(id)) this.entries.delete(id)
    }
    this.armTimer()
  }

  snapshot(): CronScheduleSnapshot[] {
    return [...this.entries.values()].map((e) => ({
      taskId: e.task.id,
      nextRunAt: e.nextRunAt,
    }))
  }

  private computeNextRunAt(task: CronTask): number | null {
    return jitteredNextCronRunMs(
      task.cron,
      this.deps.clock.now(),
      task.id,
      this.deps.jitterConfig,
    )
  }

  private nextSlotAfter(task: CronTask, fromMs: number): number | null {
    return jitteredNextCronRunMs(task.cron, fromMs, task.id, this.deps.jitterConfig)
  }

  private armTimer(): void {
    this.clearTimer()
    if (!this.started || this.suspended) return
    const now = this.deps.clock.now()
    let earliest: number | null = null
    for (const entry of this.entries.values()) {
      if (entry.nextRunAt === null) continue
      if (entry.nextRunAt <= now) {
        earliest = now
        break
      }
      if (earliest === null || entry.nextRunAt < earliest) earliest = entry.nextRunAt
    }
    if (earliest === null) return
    this.timerHandle = this.deps.timer.setTimeout(
      () => this.tick(),
      Math.max(0, earliest - now),
    )
  }

  private async tick(): Promise<void> {
    try {
      if (!this.started || this.suspended) return
      const now = this.deps.clock.now()
      for (const entry of this.entries.values()) {
        if (entry.nextRunAt === null || entry.nextRunAt > now) continue
        const slot = this.mostRecentMissedSlot(entry, now)
        if (slot === null) continue
        await this.fire(entry, slot)
      }
      this.armTimer()
    } catch {
      // Scheduling must never throw into a timer callback.
    }
  }

  private async catchUp(): Promise<void> {
    const now = this.deps.clock.now()
    for (const entry of this.entries.values()) {
      const slot = this.mostRecentMissedSlot(entry, now)
      if (slot === null) continue
      await this.fire(entry, slot)
    }
  }

  private async fire(entry: SchedulerEntry, slot: number): Promise<void> {
    try {
      await this.deps.host.onFire(entry.task, slot)
    } catch {
      // Host (coordinator) errors never break the scheduling loop.
    }
    entry.nextRunAt = this.nextSlotAfter(entry.task, slot)
  }

  /**
   * When several periods were missed (suspension, downtime, late timer),
   * the most recent missed slot wins — one catch-up fire per task. Older
   * slots stay missed; the ExecutionStore dedups any resubmission.
   */
  private mostRecentMissedSlot(entry: SchedulerEntry, now: number): number | null {
    let slot = entry.nextRunAt
    if (slot === null || slot > now) return null
    let next = this.nextSlotAfter(entry.task, slot)
    while (next !== null && next <= now) {
      slot = next
      next = this.nextSlotAfter(entry.task, slot)
    }
    return slot
  }

  private clearTimer(): void {
    if (this.timerHandle !== null) {
      this.deps.timer.clearTimeout(this.timerHandle)
      this.timerHandle = null
    }
  }
}

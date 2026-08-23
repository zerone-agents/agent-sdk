/**
 * Clock and Timer ports for the cron kernel.
 *
 * Every time read goes through CronClock and every timer through CronTimer,
 * so tests drive the kernel deterministically with FakeClock + ManualTimer.
 */

export interface CronClock {
  now(): number
}

export interface CronTimer {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const systemClock: CronClock = { now: () => Date.now() }

export const systemTimer: CronTimer = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
}

/** Deterministic clock for tests. Also usable by hosts that virtualize time. */
export class FakeClock implements CronClock {
  private current: number

  constructor(initial = 0) {
    this.current = initial
  }

  now(): number {
    return this.current
  }

  set(time: number): void {
    this.current = time
  }
}

/**
 * Manual timer for tests. `advance(ms)` fires every callback whose deadline
 * falls within the window, in deadline order, awaiting async callbacks and
 * callbacks scheduled by earlier callbacks. The clock jumps to each deadline.
 */
export class ManualTimer implements CronTimer {
  private nextId = 1
  private jobs = new Map<number, { fn: () => void; at: number }>()

  constructor(private readonly clock: FakeClock) {}

  setTimeout(fn: () => void, ms: number): number {
    const id = this.nextId++
    this.jobs.set(id, { fn, at: this.clock.now() + ms })
    return id
  }

  clearTimeout(handle: unknown): void {
    this.jobs.delete(handle as number)
  }

  pendingCount(): number {
    return this.jobs.size
  }

  async advance(ms: number): Promise<void> {
    const target = this.clock.now() + ms
    for (;;) {
      let dueId: number | null = null
      let dueAt = 0
      for (const [id, job] of this.jobs) {
        if (job.at <= target && (dueId === null || job.at < dueAt)) {
          dueId = id
          dueAt = job.at
        }
      }
      if (dueId === null) break
      const job = this.jobs.get(dueId)!
      this.jobs.delete(dueId)
      this.clock.set(job.at)
      const result = job.fn() as unknown
      if (result && typeof (result as Promise<void>).then === 'function') {
        await result
      }
    }
    this.clock.set(target)
  }
}

/** Promise-based delay routed through a CronTimer (no real sleeping in tests). */
export function waitViaTimer(timer: CronTimer, ms: number): Promise<void> {
  return new Promise((resolve) => {
    timer.setTimeout(() => resolve(), ms)
  })
}

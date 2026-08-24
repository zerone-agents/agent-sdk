import { describe, expect, it } from 'vitest'

import { FakeClock, ManualTimer } from './clock.js'
import { CronScheduler, type CronSchedulerHost } from './scheduler.js'
import type { CronStorage } from './storage.js'
import type { CronScheduleSnapshot, CronTask } from './types.js'

function makeTask(overrides: Partial<CronTask> = {}): CronTask {
  return {
    id: 'aaaaaaaa-0000-0000-0000-000000000001',
    cron: '* * * * *',
    prompt: 'p',
    createdAt: 0,
    ...overrides,
  }
}

function makeHarness(tasks: CronTask[]) {
  const clock = new FakeClock(0)
  const timer = new ManualTimer(clock)
  const storage: CronStorage = {
    load: async () => tasks.map((t) => ({ ...t })),
    get: async (id) => tasks.find((t) => t.id === id) ?? null,
    add: async () => { throw new Error('unused') },
    update: async () => null,
    remove: async () => {},
    markFired: async () => {},
  }
  const fired: Array<{ taskId: string; slot: number }> = []
  const host: CronSchedulerHost = {
    onFire: async (task, slot) => { fired.push({ taskId: task.id, slot }) },
  }
  const scheduler = new CronScheduler({ storage, clock, timer, host })
  return { clock, timer, tasks, fired, scheduler }
}

describe('CronScheduler', () => {
  it('computes a jittered next run within (period, period + jitter-cap] for every-minute crons', async () => {
    const { clock, scheduler } = makeHarness([makeTask()])
    await scheduler.start()
    const [snap] = scheduler.snapshot()
    expect(snap!.taskId).toBe(makeTask().id)
    const delay = snap!.nextRunAt! - clock.now()
    // next minute boundary is <= 60s away; jitter <= min(0.1 * 60s, 4min) = 6s
    expect(delay).toBeGreaterThan(0)
    expect(delay).toBeLessThanOrEqual(60_000 + 6_000)
  })

  it('fires the host at the scheduled slot and re-arms', async () => {
    const { clock, timer, fired, scheduler } = makeHarness([makeTask()])
    await scheduler.start()
    const first = scheduler.snapshot()[0]!.nextRunAt!

    await timer.advance(first - clock.now() + 1)

    expect(fired).toHaveLength(1)
    expect(fired[0]!.slot).toBe(first)
    // next slot must be strictly in the future and within one period + jitter
    const next = scheduler.snapshot()[0]!.nextRunAt!
    expect(next).toBeGreaterThan(clock.now())
    expect(next - clock.now()).toBeLessThanOrEqual(60_000 + 6_000)
  })

  it('drops scheduling state for tasks that disappear from storage', async () => {
    const h = makeHarness([makeTask()])
    await h.scheduler.start()
    expect(h.scheduler.snapshot()).toHaveLength(1)

    h.tasks.length = 0
    await h.scheduler.refresh()

    expect(h.scheduler.snapshot()).toHaveLength(0)
  })

  it('recomputes next run when task content changes (fingerprint diff)', async () => {
    const h = makeHarness([makeTask()])
    await h.scheduler.start()
    const before = h.scheduler.snapshot()[0]!.nextRunAt!

    h.tasks[0]!.cron = '0 0 * * *'
    await h.scheduler.refresh()

    const after = h.scheduler.snapshot()[0]!.nextRunAt!
    expect(after).not.toBe(before)
    expect(after! - h.clock.now()).toBeGreaterThan(60 * 60 * 1000)
  })

  it('keeps the existing next-run slot when the task is unchanged', async () => {
    const h = makeHarness([makeTask()])
    await h.scheduler.start()
    const before = h.scheduler.snapshot()[0]!.nextRunAt!

    await h.scheduler.refresh()

    expect(h.scheduler.snapshot()[0]!.nextRunAt).toBe(before)
  })

  it('catches up only the most recent missed slot after suspend/resume', async () => {
    const h = makeHarness([makeTask()])
    await h.scheduler.start()
    const first = h.scheduler.snapshot()[0]!.nextRunAt!

    h.scheduler.suspend()
    h.clock.set(first + 5 * 60_000) // five minutes of downtime, no timers ran
    await h.scheduler.resume()

    expect(h.fired).toHaveLength(1)
    const slot = h.fired[0]!.slot
    expect(slot).toBeGreaterThan(first)
    expect(slot).toBeLessThanOrEqual(h.clock.now())
  })

  it('is deterministic: same task id + same now -> same next run', async () => {
    const a = makeHarness([makeTask()])
    await a.scheduler.start()
    const first = a.scheduler.snapshot()[0]!.nextRunAt!

    const b = makeHarness([makeTask()])
    b.clock.set(a.clock.now())
    await b.scheduler.start()

    expect(b.scheduler.snapshot()[0]!.nextRunAt).toBe(first)
  })

  it('stops firing after stop()', async () => {
    const h = makeHarness([makeTask()])
    await h.scheduler.start()
    const first = h.scheduler.snapshot()[0]!.nextRunAt!
    h.scheduler.stop()

    await h.timer.advance(first + 120_000)

    expect(h.fired).toHaveLength(0)
    expect(h.scheduler.snapshot()).toHaveLength(0)
  })

  it('skips tasks with unparseable cron expressions (inert, no crash)', async () => {
    const h = makeHarness([makeTask({ cron: 'not a cron' })])
    await h.scheduler.start()
    const [snap] = h.scheduler.snapshot()
    expect(snap!.nextRunAt).toBeNull()
  })

  describe('restart catch-up', () => {
    it('fires the most recent missed slot once after stop/start downtime', async () => {
      const h = makeHarness([makeTask()])
      await h.scheduler.start()
      const first = h.scheduler.snapshot()[0]!.nextRunAt!

      // Simulate: slot `first` fired before shutdown; coordinator stamped lastFiredAt.
      h.tasks[0]!.lastFiredAt = first + 1
      h.scheduler.stop()

      h.clock.set(first + 5 * 60_000) // 5 minutes of downtime, no timers ran
      await h.scheduler.start() // fresh entries rebuilt from storage

      expect(h.fired).toHaveLength(1)
      const slot = h.fired[0]!.slot
      expect(slot).toBeGreaterThan(h.tasks[0]!.lastFiredAt!)
      expect(slot).toBeLessThanOrEqual(h.clock.now())
    })

    it('fires nothing on a quick restart with no missed slot', async () => {
      const h = makeHarness([makeTask()])
      await h.scheduler.start()
      const first = h.scheduler.snapshot()[0]!.nextRunAt!
      h.tasks[0]!.lastFiredAt = first + 1
      h.scheduler.stop()

      h.clock.set(first + 2_000) // restarted 2s later, next slot still future
      await h.scheduler.start()

      expect(h.fired).toHaveLength(0)
      expect(h.scheduler.snapshot()[0]!.nextRunAt).toBeGreaterThan(h.clock.now())
    })

    it('walks from createdAt when the task never fired', async () => {
      const h = makeHarness([makeTask()])
      await h.scheduler.start()
      const first = h.scheduler.snapshot()[0]!.nextRunAt!
      h.scheduler.stop()

      h.clock.set(first + 2 * 60_000)
      await h.scheduler.start()

      // anchor = createdAt (0) -> most recent slot <= now fired once
      expect(h.fired).toHaveLength(1)
      expect(h.fired[0]!.slot).toBeGreaterThan(first)
      expect(h.fired[0]!.slot).toBeLessThanOrEqual(h.clock.now())
    })
  })
})

import { describe, expect, it, vi } from 'vitest'

import { FakeClock, ManualTimer } from './clock.js'
import { createCronService, DEFAULT_MAX_CRON_TASKS } from './service.js'
import type { CronEvent, CronEventSink } from './events.js'
import type { ExecutionStore } from './execution-store.js'
import type { CronExecutor } from './executor.js'
import type { CronStorage } from './storage.js'
import type { CronExecution, CronTask } from './types.js'

class MemoryCronStorage implements CronStorage {
  tasks: CronTask[] = []
  private nextId = 1
  async load() { return this.tasks.map((t) => ({ ...t })) }
  async get(id) { return this.tasks.find((t) => t.id === id) ?? null }
  async add(task) {
    const full: CronTask = { ...task, id: `t${this.nextId++}`, createdAt: 1 }
    this.tasks.push(full)
    return { ...full }
  }
  async update(id, changes) {
    const t = this.tasks.find((x) => x.id === id)
    if (!t) return null
    Object.assign(t, changes)
    return { ...t }
  }
  async remove(ids) { this.tasks = this.tasks.filter((t) => !ids.includes(t.id)) }
  async markFired(ids, firedAt) {
    for (const t of this.tasks) if (ids.includes(t.id)) t.lastFiredAt = firedAt
  }
}

class MemoryExecutionStore implements ExecutionStore {
  executions: CronExecution[] = []
  private nextId = 1
  async recoverInterrupted() { return 0 }
  async claim(input) {
    const dup = this.executions.find(
      (e) => e.cronTaskId === input.taskId && e.scheduledFireTime === input.scheduledFireTime,
    )
    if (dup) return { kind: 'duplicate' as const, execution: dup }
    const active = this.executions.find(
      (e) => e.cronTaskId === input.taskId && (e.status === 'pending' || e.status === 'running'),
    )
    const created: CronExecution = {
      id: `e${this.nextId++}`,
      cronTaskId: input.taskId,
      scheduledFireTime: input.scheduledFireTime,
      trigger: input.trigger,
      status: active ? 'skipped' : 'pending',
    }
    this.executions.push(created)
    return { kind: active ? ('skipped' as const) : ('claimed' as const), execution: created }
  }
  async get(id) { return this.executions.find((e) => e.id === id) ?? null }
  async list(query) {
    let out = [...this.executions].sort((a, b) => b.scheduledFireTime - a.scheduledFireTime)
    if (query?.cronTaskId) out = out.filter((e) => e.cronTaskId === query.cronTaskId)
    if (query?.status) out = out.filter((e) => e.status === query.status)
    const offset = query?.offset ?? 0
    return query?.limit !== undefined ? out.slice(offset, offset + query.limit) : out.slice(offset)
  }
  async updateStatus(id, status, patch) {
    const e = this.executions.find((x) => x.id === id)
    if (!e) return null
    Object.assign(e, { status }, patch ?? {})
    return { ...e }
  }
}

function makeService(opts: {
  executor?: CronExecutor
  maxTasks?: number
  events?: CronEvent[]
  lock?: { acquire: () => Promise<void>; release: () => Promise<void> }
}) {
  const taskStorage = new MemoryCronStorage()
  const executionStore = new MemoryExecutionStore()
  const clock = new FakeClock(0)
  const timer = new ManualTimer(clock)
  const sink: CronEventSink | undefined = opts.events ? (e) => { opts.events!.push(e) } : undefined
  const executor: CronExecutor = opts.executor ?? (async () => ({ output: 'ok' }))
  const service = createCronService({
    taskStorage,
    executionStore,
    executor,
    events: sink,
    clock,
    timer,
    maxTasks: opts.maxTasks,
    lock: opts.lock,
  })
  return { service, taskStorage, executionStore, clock, timer }
}

const everyMinute = { cron: '* * * * *', prompt: 'run report' }

describe('createCronService', () => {
  it('create() validates, persists, refreshes the schedule, and emits events', async () => {
    const events: CronEvent[] = []
    const h = makeService({ events })
    await h.service.start()

    const task = await h.service.create(everyMinute)

    expect(task.id).toBeTruthy()
    expect(h.taskStorage.tasks).toHaveLength(1)
    const types = events.map((e) => e.type)
    expect(types).toContain('taskCreated')
    expect(types).toContain('scheduleUpdated')
    const schedule = events.find(
      (e) => e.type === 'scheduleUpdated' && e.snapshots.some((s) => s.taskId === task.id),
    )
    expect(schedule && schedule.type === 'scheduleUpdated' && schedule.snapshots[0]!.taskId).toBe(task.id)
  })

  it('create() rejects invalid cron without writing a task', async () => {
    const h = makeService({})
    await h.service.start()

    await expect(h.service.create({ cron: 'invalid', prompt: 'x' })).rejects.toThrow(
      /Invalid cron expression/,
    )
    expect(h.taskStorage.tasks).toHaveLength(0)
  })

  it('create() rejects cron expressions with no matching run time', async () => {
    const h = makeService({})
    await h.service.start()

    await expect(h.service.create({ cron: '0 0 30 2 *', prompt: 'x' })).rejects.toThrow(
      /no matching run time/,
    )
  })

  it('create() enforces the task limit', async () => {
    const h = makeService({ maxTasks: 1 })
    await h.service.start()
    await h.service.create(everyMinute)

    await expect(h.service.create({ cron: '*/2 * * * *', prompt: 'x' })).rejects.toThrow(
      new RegExp(`Cron task limit reached: maximum ${DEFAULT_MAX_CRON_TASKS}`.replace('50', '1')),
    )
  })

  it('delete() removes the task and throws when missing', async () => {
    const h = makeService({})
    await h.service.start()
    const task = await h.service.create(everyMinute)

    await h.service.delete(task.id)
    expect(await h.service.list()).toHaveLength(0)
    await expect(h.service.delete(task.id)).rejects.toThrow(/not found/)
  })

  it('update() applies changes, revalidates cron, and emits taskUpdated', async () => {
    const events: CronEvent[] = []
    const h = makeService({ events })
    await h.service.start()
    const task = await h.service.create(everyMinute)

    const updated = await h.service.update(task.id, { name: 'report', cron: '0 9 * * 1-5' })

    expect(updated?.name).toBe('report')
    expect(updated?.cron).toBe('0 9 * * 1-5')
    expect(events.some((e) => e.type === 'taskUpdated')).toBe(true)
    await expect(h.service.update(task.id, { cron: 'bogus' })).rejects.toThrow(/Invalid cron/)
    await expect(h.service.update('missing', { name: 'x' })).resolves.toBeNull()
  })

  it('a failed start leaves the service not accepting runNow and the lock released', async () => {
    const lock = { acquire: vi.fn(async () => {}), release: vi.fn(async () => {}) }
    const h = makeService({ lock })
    // Make scheduler startup fail: storage.load rejects until flipped back.
    let failLoad = false
    const originalLoad = h.taskStorage.load.bind(h.taskStorage)
    h.taskStorage.load = async () => {
      if (failLoad) throw new Error('tasks.json unreadable')
      return originalLoad()
    }
    failLoad = true
    await expect(h.service.start()).rejects.toThrow('tasks.json unreadable')
    expect(lock.release).toHaveBeenCalled()

    // With storage healthy again, mutations work, but runNow must be
    // rejected: the coordinator was rolled back and is not accepting work.
    failLoad = false
    const task = await h.service.create(everyMinute)
    await expect(h.service.runNow(task.id)).rejects.toThrow(/not accepting submissions/)
  })

  it('runNow() executes manually through the same coordinator', async () => {
    const h = makeService({})
    await h.service.start()
    const task = await h.service.create(everyMinute)

    const execution = await h.service.runNow(task.id)

    expect(execution.trigger).toBe('manual')
    expect(execution.status).toBe('succeeded')
    expect(execution.output).toBe('ok')
    await expect(h.service.runNow('missing')).rejects.toThrow(/not found/)
  })

  it('runNow() while the task is active records skipped', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const h = makeService({ executor: async () => { await gate; return {} } })
    await h.service.start()
    const task = await h.service.create(everyMinute)
    const first = h.service.runNow(task.id)

    // Different manual fire time (clock advanced) -> not a duplicate, but the
    // task still has an active execution -> must be recorded as skipped.
    h.clock.set(1_000)
    const second = await h.service.runNow(task.id)

    expect(second.status).toBe('skipped')
    release()
    expect(await first).toMatchObject({ status: 'succeeded' })
  })

  it('concurrent runNow calls in the same millisecond yield execute + skipped, not a duplicate', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const h = makeService({ executor: async () => { await gate; return {} } })
    await h.service.start()
    const task = await h.service.create(everyMinute)

    // Launch both concurrently (fire keys are captured synchronously at
    // invocation, i.e. within the same frozen-clock millisecond), then
    // release the gate so the succeeded execution can settle.
    const pending = [h.service.runNow(task.id), h.service.runNow(task.id)]
    release()
    const [a, b] = await Promise.all(pending)

    const statuses = [a.status, b.status].sort()
    expect(statuses).toEqual(['skipped', 'succeeded']) // NOT duplicate/pending
    expect(a.id).not.toBe(b.id)
    release() // gate already consumed by the succeeded one; safe no-op otherwise
  })

  it('sequential runNow calls on a frozen clock are distinct executions', async () => {
    const h = makeService({})
    await h.service.start()
    const task = await h.service.create(everyMinute)

    const first = await h.service.runNow(task.id)
    const second = await h.service.runNow(task.id)

    expect(first.id).not.toBe(second.id)
    expect(second.status).toBe('succeeded')
    expect(second.scheduledFireTime).toBeGreaterThan(first.scheduledFireTime)
  })

  it('get/listExecutions/getExecution delegate to the stores', async () => {
    const h = makeService({})
    await h.service.start()
    const task = await h.service.create(everyMinute)
    const execution = await h.service.runNow(task.id)

    expect((await h.service.get(task.id))?.id).toBe(task.id)
    expect(await h.service.get('missing')).toBeNull()
    expect(await h.service.listExecutions({ cronTaskId: task.id })).toHaveLength(1)
    expect((await h.service.getExecution(execution.id))?.id).toBe(execution.id)
    expect(await h.service.getExecution('missing')).toBeNull()
  })

  it('acquires the lock on start() and releases it on stop()', async () => {
    const lock = { acquire: vi.fn(async () => {}), release: vi.fn(async () => {}) }
    const h = makeService({ lock })
    await h.service.start()
    expect(lock.acquire).toHaveBeenCalledTimes(1)

    await h.service.stop()
    expect(lock.release).toHaveBeenCalledTimes(1)
  })

  it('releases the lock when start() fails', async () => {
    const lock = {
      acquire: async () => { throw new Error('already running') },
      release: vi.fn(async () => {}),
    }
    const h = makeService({ lock })

    await expect(h.service.start()).rejects.toThrow('already running')
    expect(lock.release).toHaveBeenCalledTimes(1)
  })

  it('a second start() on a running service is a no-op (no acquire, no release)', async () => {
    const lock = { acquire: vi.fn(async () => {}), release: vi.fn(async () => {}) }
    const h = makeService({ lock })
    await h.service.start()
    expect(lock.acquire).toHaveBeenCalledTimes(1)

    // Double start must not throw, must not re-acquire, and — critically —
    // must not release the still-live lock.
    await expect(h.service.start()).resolves.toBeUndefined()
    expect(lock.acquire).toHaveBeenCalledTimes(1)
    expect(lock.release).not.toHaveBeenCalled()

    // The runtime is still running: stop() works exactly once.
    await h.service.stop()
    expect(lock.release).toHaveBeenCalledTimes(1)
  })

  it('start() while suspended is a no-op', async () => {
    const lock = { acquire: vi.fn(async () => {}), release: vi.fn(async () => {}) }
    const h = makeService({ lock })
    await h.service.start()
    await h.service.suspend()

    await expect(h.service.start()).resolves.toBeUndefined()
    expect(lock.acquire).toHaveBeenCalledTimes(1)
    expect(lock.release).not.toHaveBeenCalled()

    await h.service.resume()
    await h.service.stop()
  })

  it('fires scheduled executions end-to-end via the injected timer', async () => {
    const h = makeService({})
    await h.service.start()
    const task = await h.service.create(everyMinute)

    // Next jittered slot is within (0, 66s]; advancing 66s crosses exactly one slot.
    await h.timer.advance(60_000 + 6_000)

    // Scheduled fires are fire-and-forget: the submit chain floats after the
    // advance, so poll (real timers; the memory store resolves in microtasks)
    // instead of sleeping.
    await vi.waitFor(async () => {
      const executions = await h.service.listExecutions({ cronTaskId: task.id })
      expect(executions).toHaveLength(1)
      expect(executions[0]).toMatchObject({ status: 'succeeded', output: 'ok' })
    })
    const after = await h.service.get(task.id)
    expect(after?.lastFiredAt).toBeDefined()
  })

  it('a hung execution does not stall other tasks (cross-task non-blocking)', async () => {
    // Task A's executor never resolves on its own — it only settles when the
    // abort signal fires (stop with drainMs 0). Task B must still fire on
    // time while A is stuck, proving the scheduler is a pure timer loop.
    const executor: CronExecutor = async (task, context) => {
      if (task.prompt === 'hang') {
        await new Promise((_, reject) => {
          if (context.signal.aborted) reject(context.signal.reason)
          else context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true })
        })
      }
      return { output: 'ok' }
    }
    const h = makeService({ executor })
    await h.service.start()
    const taskA = await h.service.create({ cron: '* * * * *', prompt: 'hang' })
    const taskB = await h.service.create({ cron: '* * * * *', prompt: 'work' })

    // Cross A's first slot and part of B's window (jittered within (0, 66s]
    // after their own refresh); B is due while A is still hanging.
    await h.timer.advance(2 * 60_000)

    await vi.waitFor(async () => {
      const b = await h.service.listExecutions({ cronTaskId: taskB.id })
      expect(b.some((e) => e.status === 'succeeded' && e.output === 'ok')).toBe(true)
    })
    // A has fired but never reached a terminal status while hanging (later
    // slots are recorded as skipped while its first execution is active).
    const a = await h.service.listExecutions({ cronTaskId: taskA.id })
    expect(a.some((e) => e.status === 'running' || e.status === 'pending')).toBe(true)
    expect(a.some((e) => e.status === 'succeeded' || e.status === 'failed')).toBe(false)

    // Cleanup: stop with drainMs 0 aborts A (interrupted); no dangling handles.
    await h.service.stop({ drainMs: 0 })
    const aAfter = await h.service.listExecutions({ cronTaskId: taskA.id })
    expect(aAfter.some((e) => e.status === 'interrupted')).toBe(true)
  })

  it('catches up the most recent missed slot after a full restart', async () => {
    const h = makeService({})
    await h.service.start()
    const task = await h.service.create(everyMinute)

    await h.timer.advance(60_000 + 6_000) // fires slot 1; markFired stamps lastFiredAt
    await vi.waitFor(async () => {
      const execs = await h.service.listExecutions({ cronTaskId: task.id })
      expect(execs).toHaveLength(1)
      expect(execs[0]!.status).toBe('succeeded')
    })
    // Flush the fire-and-forget chain (active-run bookkeeping) before stop()
    // so the drain loop has nothing in flight under the manual timer.
    await new Promise((r) => setTimeout(r, 0))
    await h.service.stop()

    h.clock.set(h.clock.now() + 5 * 60_000) // downtime, no timers ran

    await h.service.start()

    // Scheduled fires are fire-and-forget; poll for the catch-up execution.
    await vi.waitFor(async () => {
      expect(await h.service.listExecutions({ cronTaskId: task.id })).toHaveLength(2)
    })
    const executions = await h.service.listExecutions({ cronTaskId: task.id })
    expect(executions[0]!.status).toBe('succeeded')
    // Newest first: the catch-up fire is the most recent missed slot.
    expect(executions[0]!.scheduledFireTime).toBeGreaterThan(executions[1]!.scheduledFireTime)
    expect(executions[0]!.scheduledFireTime).toBeLessThanOrEqual(h.clock.now())
  })
})

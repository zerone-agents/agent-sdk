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

  it('fires scheduled executions end-to-end via the injected timer', async () => {
    const h = makeService({})
    await h.service.start()
    const task = await h.service.create(everyMinute)

    // Next jittered slot is within (0, 66s]; advancing 66s crosses exactly one slot.
    await h.timer.advance(60_000 + 6_000)

    const executions = await h.service.listExecutions({ cronTaskId: task.id })
    expect(executions).toHaveLength(1)
    expect(executions[0]).toMatchObject({ status: 'succeeded', output: 'ok' })
    const after = await h.service.get(task.id)
    expect(after?.lastFiredAt).toBeDefined()
  })
})

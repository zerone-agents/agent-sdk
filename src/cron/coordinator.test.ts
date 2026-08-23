import { describe, expect, it, vi } from 'vitest'

import { FakeClock, ManualTimer } from './clock.js'
import {
  CronExecutionCoordinator,
  CronExecutionInterruptedError,
} from './coordinator.js'
import type { CronEvent, CronEventSink } from './events.js'
import type { ExecutionStore } from './execution-store.js'
import type { CronExecutor } from './executor.js'
import type { CronStorage } from './storage.js'
import type { CronExecution, CronTask } from './types.js'

const task: CronTask = {
  id: 't1',
  cron: '* * * * *',
  prompt: 'run report',
  createdAt: 0,
}

function execution(overrides: Partial<CronExecution> = {}): CronExecution {
  return {
    id: 'e1',
    cronTaskId: 't1',
    scheduledFireTime: 60_000,
    trigger: 'scheduled',
    status: 'pending',
    ...overrides,
  }
}

/** In-memory ExecutionStore mirroring the port contract. */
function createStore(seeded: CronExecution[] = []) {
  const executions = new Map(seeded.map((e) => [e.id, { ...e }]))
  const byFire = new Map(
    [...executions.values()].map((e) => [`${e.cronTaskId}:${e.scheduledFireTime}`, e.id] as const),
  )
  let activeByTask = new Map(
    [...executions.values()]
      .filter((e) => e.status === 'pending' || e.status === 'running')
      .map((e) => [e.cronTaskId, e.id] as const),
  )
  let nextId = 1
  const store: ExecutionStore = {
    async recoverInterrupted() {
      let count = 0
      for (const e of [...executions.values()]) {
        if (e.status === 'pending' || e.status === 'running') {
          e.status = 'interrupted'
          e.completedAt = 1
          count++
        }
      }
      activeByTask = new Map()
      return count
    },
    async claim(input) {
      const key = `${input.taskId}:${input.scheduledFireTime}`
      const existingId = byFire.get(key)
      if (existingId) {
        return { kind: 'duplicate', execution: executions.get(existingId)! }
      }
      const activeId = activeByTask.get(input.taskId)
      const created = execution({
        id: `e${nextId++}`,
        cronTaskId: input.taskId,
        scheduledFireTime: input.scheduledFireTime,
        trigger: input.trigger,
        status: activeId ? 'skipped' : 'pending',
      })
      executions.set(created.id, created)
      byFire.set(key, created.id)
      if (!activeId) activeByTask.set(input.taskId, created.id)
      return { kind: activeId ? 'skipped' : 'claimed', execution: created }
    },
    async get(id) { return executions.get(id) ?? null },
    async list() { return [...executions.values()] },
    async updateStatus(id, status, patch) {
      const e = executions.get(id)
      if (!e) return null
      Object.assign(e, { status }, patch ?? {})
      if (status !== 'pending' && status !== 'running') {
        if (activeByTask.get(e.cronTaskId) === id) activeByTask.delete(e.cronTaskId)
      }
      return { ...e }
    },
  }
  return { store, executions }
}

function makeHarness(opts: {
  executor: CronExecutor
  seeded?: CronExecution[]
  executionTimeoutMs?: number
}) {
  const clock = new FakeClock(0)
  const timer = new ManualTimer(clock)
  const { store, executions } = createStore(opts.seeded)
  const markFired = vi.fn()
  const storage = {
    load: async () => [],
    get: async () => null,
    add: async () => { throw new Error('unused') },
    update: async () => null,
    remove: async () => {},
    markFired,
  } as CronStorage
  const events: CronEvent[] = []
  const sink: CronEventSink = (e) => { events.push(e) }
  const coordinator = new CronExecutionCoordinator({
    executionStore: store,
    executor: opts.executor,
    storage,
    clock,
    timer,
    events: sink,
    executionTimeoutMs: opts.executionTimeoutMs,
  })
  return { clock, timer, executions, markFired, events, coordinator }
}

const okExecutor: CronExecutor = async () => ({ output: 'done' })

describe('CronExecutionCoordinator', () => {
  it('runs a claimed execution to succeeded with output and events', async () => {
    const h = makeHarness({ executor: okExecutor })
    await h.coordinator.start()

    const result = await h.coordinator.submit(task, 60_000, 'scheduled')

    expect(result.status).toBe('succeeded')
    expect(result.output).toBe('done')
    expect(result.startedAt).toBe(0)
    expect(result.completedAt).toBe(0)
    expect(h.markFired).toHaveBeenCalledWith(['t1'], 0)
    const types = h.events.map((e) => e.type)
    expect(types).toContain('executionStarted')
    expect(types).toContain('executionCompleted')
  })

  it('returns the existing execution on duplicate (taskId, fireTime)', async () => {
    const executor = vi.fn(okExecutor)
    const h = makeHarness({ executor })
    await h.coordinator.start()
    const first = await h.coordinator.submit(task, 60_000, 'scheduled')

    const second = await h.coordinator.submit(task, 60_000, 'scheduled')

    expect(second.id).toBe(first.id)
    expect(executor).toHaveBeenCalledTimes(1)
  })

  it('records skipped when the task already has an active execution', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const slowExecutor: CronExecutor = async () => { await gate; return { output: 'slow' } }
    const h = makeHarness({ executor: slowExecutor })
    await h.coordinator.start()
    const first = h.coordinator.submit(task, 60_000, 'scheduled')

    const manual = await h.coordinator.submit(task, 61_000, 'manual')

    expect(manual.status).toBe('skipped')
    expect(first).toBeDefined()
    release()
    await h.coordinator.idle()
    expect(h.executions.get((await first).id)?.status).toBe('succeeded')
  })

  it('marks failed with the error message when the executor throws', async () => {
    const executor: CronExecutor = async () => { throw new Error('boom') }
    const h = makeHarness({ executor })
    await h.coordinator.start()

    const result = await h.coordinator.submit(task, 60_000, 'scheduled')

    expect(result.status).toBe('failed')
    expect(result.error).toBe('boom')
  })

  it('marks timeout when the execution exceeds executionTimeoutMs', async () => {
    const executor: CronExecutor = (t, ctx) =>
      new Promise((_resolve, reject) => {
        ctx.signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('AbortError'), { name: 'AbortError' })),
        )
      })
    const h = makeHarness({ executor, executionTimeoutMs: 100 })
    await h.coordinator.start()

    const promise = h.coordinator.submit(task, 60_000, 'scheduled')
    await h.timer.advance(100)
    const result = await promise

    expect(result.status).toBe('timeout')
    expect(result.error).toContain('timed out')
  })

  it('marks interrupted on suspend and aborts the executor', async () => {
    const executor: CronExecutor = (t, ctx) =>
      new Promise((_resolve, reject) => {
        ctx.signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('AbortError'), { name: 'AbortError' })),
        )
      })
    const h = makeHarness({ executor })
    await h.coordinator.start()
    const promise = h.coordinator.submit(task, 60_000, 'scheduled')

    await h.coordinator.suspend()
    const result = await promise

    expect(result.status).toBe('interrupted')
  })

  it('drains within drainMs, then interrupts the rest, and rejects new submissions', async () => {
    const executor: CronExecutor = (t, ctx) =>
      new Promise((_resolve, reject) => {
        ctx.signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('AbortError'), { name: 'AbortError' })),
        )
      })
    const h = makeHarness({ executor })
    await h.coordinator.start()
    const promise = h.coordinator.submit(task, 60_000, 'scheduled')

    const stopPromise = h.coordinator.stop({ drainMs: 50 })
    await expect(h.coordinator.submit(task, 120_000, 'scheduled')).rejects.toThrow(
      /not accepting submissions/,
    )
    await h.timer.advance(50)
    const [result] = await Promise.all([promise, stopPromise])

    expect(result.status).toBe('interrupted')
  })

  it('recovers leftover pending/running records on start', async () => {
    const h = makeHarness({
      executor: okExecutor,
      seeded: [execution({ id: 'old', status: 'running' })],
    })

    await h.coordinator.start()

    expect(h.executions.get('old')?.status).toBe('interrupted')
  })

  it('shares the state machine between manual and scheduled triggers', async () => {
    const h = makeHarness({ executor: okExecutor })
    await h.coordinator.start()

    const manual = await h.coordinator.submit(task, 123, 'manual')

    expect(manual.trigger).toBe('manual')
    expect(manual.status).toBe('succeeded')
  })

  it('CronExecutionInterruptedError is constructible with a reason', () => {
    expect(new CronExecutionInterruptedError('stop').message).toContain('stop')
  })
})

import { describe, expect, it, vi } from 'vitest'

import { FakeClock, ManualTimer } from './clock.js'
import {
  createCronService,
  CronServiceStoppingError,
  DEFAULT_MAX_CRON_TASKS,
} from './service.js'
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
  /** dedup key -> execution id; honors input.dedupKey like FileExecutionStore. */
  private byFire = new Map<string, string>()
  private nextId = 1
  async recoverInterrupted() { return 0 }
  async claim(input) {
    const key = input.dedupKey ?? `${input.taskId}:${input.scheduledFireTime}`
    const dupId = this.byFire.get(key)
    const dup = dupId !== undefined ? this.executions.find((e) => e.id === dupId) : undefined
    // In-place semantics on purpose (review: the initial-record contract must
    // not depend on the store adapter): the stored object is returned by
    // reference and mutated in updateStatus — the coordinator's claim-boundary
    // snapshot must guarantee the caller's `pending` record regardless.
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
    this.byFire.set(key, created.id)
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
  eventSink?: CronEventSink
  onDiagnostic?: (message: string) => void
  lock?: { acquire: () => Promise<void>; release: () => Promise<void> }
}) {
  const taskStorage = new MemoryCronStorage()
  const executionStore = new MemoryExecutionStore()
  const clock = new FakeClock(0)
  const timer = new ManualTimer(clock)
  const sink: CronEventSink | undefined =
    opts.eventSink ?? (opts.events ? (e) => { opts.events!.push(e) } : undefined)
  const executor: CronExecutor = opts.executor ?? (async () => ({ output: 'ok' }))
  const service = createCronService({
    taskStorage,
    executionStore,
    executor,
    events: sink,
    clock,
    timer,
    maxTasks: opts.maxTasks,
    onDiagnostic: opts.onDiagnostic,
    lock: opts.lock,
  })
  return { service, taskStorage, executionStore, clock, timer }
}

const everyMinute = { cron: '* * * * *', prompt: 'run report' }

describe('createCronService', () => {
  it('a throwing events sink does not affect execution state; failures are reported via onDiagnostic', async () => {
    const onDiagnostic = vi.fn()
    const h = makeService({
      eventSink: () => { throw new Error('sink exploded') },
      onDiagnostic,
    })
    await h.service.start()

    const task = await h.service.create(everyMinute)
    const execution = await h.service.runNow(task.id)

    // Diagnostics were reported for every failed emit.
    expect(onDiagnostic).toHaveBeenCalled()
    for (const call of onDiagnostic.mock.calls) {
      expect(call[0]).toMatch(/cron event sink failed/)
    }
    // State is unaffected: the execution still succeeded.
    expect(execution.status).toBe('succeeded')
    expect(await h.executionStore.get(execution.id)).toMatchObject({ status: 'succeeded' })
  })

  it('a throwing onDiagnostic does not affect runNow execution state', async () => {
    const h = makeService({
      eventSink: () => { throw new Error('sink exploded') },
      onDiagnostic: () => { throw new Error('diagnostics exploded') },
    })
    await h.service.start()
    const task = await h.service.create(everyMinute)

    // Both channels are broken; the execution must still succeed.
    const execution = await h.service.runNow(task.id)
    expect(execution.status).toBe('succeeded')
    expect(await h.executionStore.get(execution.id)).toMatchObject({ status: 'succeeded' })
  })

  it('a throwing onDiagnostic during a failed scheduled submit causes no unhandled rejection and keeps scheduling', async () => {
    // Deterministic unhandled-rejection recorder: if the detached submit
    // handler's diagnostics path were to throw, Node would surface it here.
    const unhandled: unknown[] = []
    const onUnhandled = (err: unknown) => { unhandled.push(err) }
    process.on('unhandledRejection', onUnhandled)
    try {
      const h = makeService({ onDiagnostic: () => { throw new Error('diagnostics exploded') } })
      await h.service.start()
      const task = await h.service.create(everyMinute)

      let failNextClaim = true
      const originalClaim = h.executionStore.claim.bind(h.executionStore)
      h.executionStore.claim = async (input) => {
        if (failNextClaim && input.trigger === 'scheduled') {
          failNextClaim = false
          throw new Error('claim failed')
        }
        return originalClaim(input)
      }

      await h.timer.advance(60_000 + 6_000) // crosses slot 1 -> submit rejects
      // Flush microtasks/immediates so a rejection (if any) would surface.
      await new Promise((r) => setImmediate(r))

      // The scheduler is unaffected: the next slot still fires and succeeds.
      await h.timer.advance(60_000 + 66_000)
      await vi.waitFor(async () => {
        const executions = await h.service.listExecutions({ cronTaskId: task.id })
        expect(executions.some((e) => e.status === 'succeeded' && e.trigger === 'scheduled')).toBe(true)
      })
      await new Promise((r) => setImmediate(r))

      expect(unhandled).toEqual([])

      // The leak documented in round-2 review is fixed: claimAndRun now
      // cleans up (clearTimeout + pending.delete) when claim rejects, so
      // stop() cannot abort a leaked submission's unhandled abortPromise.
      await h.service.stop()
      await new Promise((r) => setImmediate(r))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

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
    // No drift: identity comes from a unique dedup key, not synthetic fire
    // times — both executions report the REAL (frozen) clock time.
    expect(first.scheduledFireTime).toBe(h.clock.now())
    expect(second.scheduledFireTime).toBe(h.clock.now())
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

  it('reports scheduled submit failures via onDiagnostic and keeps scheduling', async () => {
    const onDiagnostic = vi.fn()
    const h = makeService({ onDiagnostic })
    await h.service.start()
    const task = await h.service.create(everyMinute)

    // Make the FIRST scheduled fire fail inside submit: executionStore.claim
    // rejects once (a genuine scheduled-path rejection, not a sink failure).
    let failNextClaim = true
    const originalClaim = h.executionStore.claim.bind(h.executionStore)
    h.executionStore.claim = async (input) => {
      if (failNextClaim && input.trigger === 'scheduled') {
        failNextClaim = false
        throw new Error('claim failed')
      }
      return originalClaim(input)
    }

    await h.timer.advance(60_000 + 6_000) // crosses slot 1 -> submit rejects
    await vi.waitFor(() => {
      expect(onDiagnostic).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`scheduled submit failed for ${task.id}: claim failed`)),
      )
    })

    // The scheduler is unaffected: the next slot (minute boundary + full
    // jitter window) still fires and succeeds.
    await h.timer.advance(60_000 + 66_000)
    await vi.waitFor(async () => {
      const executions = await h.service.listExecutions({ cronTaskId: task.id })
      expect(executions.some((e) => e.status === 'succeeded' && e.trigger === 'scheduled')).toBe(true)
    })
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

describe('enqueueNow (issue #51)', () => {
  function makeGatedExecutor(): {
    executor: CronExecutor
    release: () => void
    calls: () => number
  } {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    const executor: CronExecutor = async () => {
      calls += 1
      await gate
      return { output: 'gated' }
    }
    return { executor, release, calls: () => calls }
  }

  it('returns the durable pending record; the execution completes in the background; runNow still awaits terminal', async () => {
    const gated = makeGatedExecutor()
    const h = makeService({ executor: gated.executor })
    await h.service.start()
    const task = await h.service.create(everyMinute)

    const execution = await h.service.enqueueNow(task.id)
    expect(execution.status).toBe('pending')
    expect(execution.trigger).toBe('manual')

    // Durable immediately: observable via getExecution while the executor
    // is still gated. The live record may already show `running` depending
    // on scheduling — what matters is retrievability under the same id.
    const observed = await h.service.getExecution(execution.id)
    expect(observed).toMatchObject({ id: execution.id, trigger: 'manual' })
    expect(['pending', 'running']).toContain(observed?.status)

    gated.release()
    await vi.waitFor(async () => {
      expect(await h.service.getExecution(execution.id)).toMatchObject({ status: 'succeeded' })
    })

    // Contrast: runNow continues to await the terminal state.
    const viaRunNow = await h.service.runNow(task.id)
    expect(viaRunNow.status).toBe('succeeded')
  })

  it('an active same-task execution yields a persisted skipped record without starting another agent', async () => {
    const gated = makeGatedExecutor()
    const h = makeService({ executor: gated.executor })
    await h.service.start()
    const task = await h.service.create(everyMinute)

    const first = await h.service.enqueueNow(task.id)
    expect(first.status).toBe('pending')

    const second = await h.service.enqueueNow(task.id)
    expect(second.status).toBe('skipped')
    expect(second.id).not.toBe(first.id)
    // The skipped record is durable.
    expect(await h.service.getExecution(second.id)).toMatchObject({ status: 'skipped' })

    gated.release()
    await vi.waitFor(async () => {
      expect(await h.service.getExecution(first.id)).toMatchObject({ status: 'succeeded' })
    })
    expect(gated.calls()).toBe(1)
  })

  it('a claim persistence failure rejects enqueueNow with no phantom execution and no detached rejection', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (err: unknown) => {
      unhandled.push(err)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const h = makeService({})
      await h.service.start()
      const task = await h.service.create(everyMinute)

      const originalClaim = h.executionStore.claim.bind(h.executionStore)
      h.executionStore.claim = async (input) => {
        if (input.trigger === 'manual') throw new Error('claim persistence failed')
        return originalClaim(input)
      }

      await expect(h.service.enqueueNow(task.id)).rejects.toThrow('claim persistence failed')

      await new Promise((r) => setImmediate(r))
      expect(unhandled).toEqual([])
      // No phantom record was created for the refused submission.
      expect(await h.service.listExecutions({ cronTaskId: task.id })).toEqual([])

      await h.service.stop()
      await new Promise((r) => setImmediate(r))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('an executor failure after enqueueNow resolves becomes failed with no unhandled rejection', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (err: unknown) => {
      unhandled.push(err)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const executor: CronExecutor = async () => {
        throw new Error('agent exploded')
      }
      const h = makeService({ executor })
      await h.service.start()
      const task = await h.service.create(everyMinute)

      const execution = await h.service.enqueueNow(task.id)
      expect(execution.status).toBe('pending')

      await vi.waitFor(async () => {
        expect(await h.service.getExecution(execution.id)).toMatchObject({
          status: 'failed',
          error: 'agent exploded',
        })
      })
      await new Promise((r) => setImmediate(r))
      expect(unhandled).toEqual([])

      await h.service.stop()
      await new Promise((r) => setImmediate(r))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('stop() drains/interrupts an enqueued execution still running', async () => {
    const gated = makeGatedExecutor()
    const h = makeService({ executor: gated.executor })
    await h.service.start()
    const task = await h.service.create(everyMinute)

    const execution = await h.service.enqueueNow(task.id)
    expect(execution.status).toBe('pending')

    // drainMs: 0 skips the drain polling (which parks on the manual timer)
    // and interrupts the still-gated execution immediately.
    await h.service.stop({ drainMs: 0 })

    expect(await h.service.getExecution(execution.id)).toMatchObject({ status: 'interrupted' })
    gated.release()
  })

  it('suspend() interrupts an enqueued execution', async () => {
    const gated = makeGatedExecutor()
    const h = makeService({ executor: gated.executor })
    await h.service.start()
    const task = await h.service.create(everyMinute)

    const execution = await h.service.enqueueNow(task.id)
    await h.service.suspend()

    expect(await h.service.getExecution(execution.id)).toMatchObject({ status: 'interrupted' })
    gated.release()
    await h.service.stop()
  })

  it('concurrent enqueueNow calls preserve one-active semantics with distinct identities', async () => {
    const gated = makeGatedExecutor()
    const h = makeService({ executor: gated.executor })
    await h.service.start()
    const task = await h.service.create(everyMinute)

    const [a, b] = await Promise.all([h.service.enqueueNow(task.id), h.service.enqueueNow(task.id)])
    const statuses = [a.status, b.status].sort()
    expect(statuses).toEqual(['pending', 'skipped'])
    expect(a.id).not.toBe(b.id)

    gated.release()
    await vi.waitFor(async () => {
      const execs = await h.service.listExecutions({ cronTaskId: task.id })
      expect(execs.some((e) => e.status === 'succeeded')).toBe(true)
    })
    expect(gated.calls()).toBe(1)
    await h.service.stop()
  })
})

describe('shutdown barrier (issue #57)', () => {
  /** Lock double that records release order and counts releases. */
  function makeRecordingLock(order: string[]) {
    let releases = 0
    return {
      lock: {
        acquire: async () => {},
        release: async () => {
          releases += 1
          order.push('lock-release')
        },
      },
      releaseCount: () => releases,
    }
  }

  /** Gates taskStorage.add so a protected operation can be held mid-flight. */
  function gateStorageAdd(storage: MemoryCronStorage, order?: string[]) {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const originalAdd = storage.add.bind(storage)
    ;(storage as unknown as { add: (t: unknown) => Promise<unknown> }).add = async (
      input: unknown,
    ) => {
      await gate
      const task = await originalAdd(input as never)
      order?.push('add-done')
      return task
    }
    return release
  }

  it('a held create settles before the directory lock is released', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (err: unknown) => {
      unhandled.push(err)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const order: string[] = []
      const { lock } = makeRecordingLock(order)
      const h = makeService({ lock })
      await h.service.start()
      const releaseAdd = gateStorageAdd(h.taskStorage, order)

      const held = h.service.create(everyMinute)
      await new Promise((r) => setImmediate(r)) // entered; parked at the gate

      const stopping = h.service.stop({ drainMs: 0 })
      await new Promise((r) => setImmediate(r))
      // stop() is parked on the barrier: the entered create has not settled,
      // so the lock must NOT be released yet.
      expect(order).not.toContain('lock-release')

      releaseAdd()
      const task = await held
      expect(task.id).toBeTruthy()
      await stopping
      // The storage write settled strictly before the lock release — a
      // second process can only acquire after this point.
      expect(order.indexOf('add-done')).toBeLessThan(order.indexOf('lock-release'))

      await new Promise((r) => setImmediate(r))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('new protected operations and lifecycle transitions fail with the typed error during and after shutdown', async () => {
    const h = makeService({})
    await h.service.start()
    const task = await h.service.create(everyMinute)

    const releaseAdd = gateStorageAdd(h.taskStorage)
    const held = h.service.create(everyMinute)
    await new Promise((r) => setImmediate(r))
    const stopping = h.service.stop({ drainMs: 0 })
    await new Promise((r) => setImmediate(r))

    // Protected operations reject with the stable typed error while stopping.
    await expect(h.service.create(everyMinute)).rejects.toBeInstanceOf(CronServiceStoppingError)
    await expect(h.service.update(task.id, { name: 'x' })).rejects.toBeInstanceOf(
      CronServiceStoppingError,
    )
    await expect(h.service.delete(task.id)).rejects.toBeInstanceOf(CronServiceStoppingError)
    await expect(h.service.runNow(task.id)).rejects.toBeInstanceOf(CronServiceStoppingError)
    await expect(h.service.enqueueNow(task.id)).rejects.toBeInstanceOf(CronServiceStoppingError)
    // Lifecycle transitions cannot reopen operations during shutdown.
    await expect(h.service.start()).rejects.toBeInstanceOf(CronServiceStoppingError)
    await expect(h.service.suspend()).rejects.toBeInstanceOf(CronServiceStoppingError)
    await expect(h.service.resume()).rejects.toBeInstanceOf(CronServiceStoppingError)
    // Read-only methods remain available during stopping.
    expect(await h.service.list()).toHaveLength(1)
    expect(await h.service.get(task.id)).not.toBeNull()

    releaseAdd()
    await held
    await stopping

    // After a full stop the same lock-safety rule applies (no lock held).
    await expect(h.service.create(everyMinute)).rejects.toBeInstanceOf(CronServiceStoppingError)
    await expect(h.service.enqueueNow(task.id)).rejects.toBeInstanceOf(CronServiceStoppingError)
    // Read-only methods remain available after stop.
    expect(await h.service.list()).toHaveLength(2)
  })

  it('scheduler intake stops promptly, not delayed by a held operation', async () => {
    let calls = 0
    const executor: CronExecutor = async () => {
      calls += 1
      return { output: 'x' }
    }
    const h = makeService({ executor })
    await h.service.start()
    const task = await h.service.create(everyMinute) // fires around t=60s

    const releaseAdd = gateStorageAdd(h.taskStorage)
    const held = h.service.create(everyMinute)
    await new Promise((r) => setImmediate(r))
    const stopping = h.service.stop({ drainMs: 0 }) // unawaited: intake must stop NOW
    await new Promise((r) => setImmediate(r))

    // Advance far past the next slot: intake is stopped, so nothing fires
    // even though stop() is still parked on the held create.
    await h.timer.advance(10 * 60_000)
    expect(calls).toBe(0)
    expect(await h.service.listExecutions({ cronTaskId: task.id })).toEqual([])

    releaseAdd()
    await held
    await stopping
  })

  it('a hung runNow is settled by the interrupt phase, so the barrier clears and the lock releases', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (err: unknown) => {
      unhandled.push(err)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const order: string[] = []
      const { lock } = makeRecordingLock(order)
      let releaseExecutor!: () => void
      const executorGate = new Promise<void>((resolve) => {
        releaseExecutor = resolve
      })
      let started = 0
      const executor: CronExecutor = async () => {
        started += 1
        await executorGate
        return { output: 'never' }
      }
      const h = makeService({ executor, lock })
      await h.service.start()
      const task = await h.service.create(everyMinute)

      const run = h.service.runNow(task.id)
      await vi.waitFor(() => expect(started).toBe(1)) // execution is active

      // drainMs: 0 skips the grace and interrupts — which settles the hung
      // runNow, which clears the barrier, which releases the lock.
      const stopping = h.service.stop({ drainMs: 0 })
      const result = await run
      expect(result.status).toBe('interrupted')
      order.push('run-settled')
      await stopping
      expect(order.indexOf('run-settled')).toBeLessThan(order.indexOf('lock-release'))

      releaseExecutor()
      await new Promise((r) => setImmediate(r))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('stop() is idempotent and concurrent callers observe the same outcome; the lock releases once', async () => {
    const order: string[] = []
    const { lock, releaseCount } = makeRecordingLock(order)
    const h = makeService({ lock })
    await h.service.start()
    const releaseAdd = gateStorageAdd(h.taskStorage)
    const held = h.service.create(everyMinute)
    await new Promise((r) => setImmediate(r))

    // Two concurrent stop() calls: both park on the same barrier; do NOT
    // await them yet (they resolve only after the held create settles).
    const stopA = h.service.stop({ drainMs: 0 })
    const stopB = h.service.stop({ drainMs: 0 })
    await new Promise((r) => setImmediate(r))
    expect(releaseCount()).toBe(0) // still parked on the held create

    releaseAdd()
    await held
    await Promise.all([stopA, stopB])
    expect(releaseCount()).toBe(1)

    // stop() after a full stop is a no-op — no second release.
    await h.service.stop()
    expect(releaseCount()).toBe(1)
  })

  it('active executions still receive the drainMs grace during shutdown', async () => {
    let releaseExecutor!: () => void
    const executorGate = new Promise<void>((resolve) => {
      releaseExecutor = resolve
    })
    const executor: CronExecutor = async () => {
      await executorGate
      return { output: 'graceful' }
    }
    const h = makeService({ executor })
    await h.service.start()
    const task = await h.service.create(everyMinute)
    const execution = await h.service.enqueueNow(task.id)

    const stopping = h.service.stop({ drainMs: 10_000 })
    await h.timer.advance(1_000) // inside the grace window; still running
    releaseExecutor()
    // Flush microtasks so the run completes and clears its active slot
    // BEFORE the next drain poll fires (ManualTimer fires poll callbacks
    // synchronously; without the flush, the poll's idle check can race the
    // run-completion chain and re-arm a poll nobody advances).
    await new Promise((r) => setImmediate(r))
    await h.timer.advance(2_000) // drain poll observes the completion
    await stopping

    expect(await h.service.getExecution(execution.id)).toMatchObject({ status: 'succeeded' })
  })

  it('protected operations remain available before the first start() and reject only after shutdown', async () => {
    const h = makeService({})
    // Setup/recovery flows keep working pre-start (backward-compatible
    // behavior); the typed rejection applies to shutdown, not setup.
    const task = await h.service.create(everyMinute)
    expect(task.id).toBeTruthy()
    expect(await h.service.list()).toHaveLength(1)

    await h.service.start()
    expect((await h.service.runNow(task.id)).status).toBe('succeeded')
    await h.service.stop()

    // After a shutdown stop the lock is released — mutations reject.
    await expect(h.service.create(everyMinute)).rejects.toBeInstanceOf(CronServiceStoppingError)
    await expect(h.service.enqueueNow(task.id)).rejects.toBeInstanceOf(CronServiceStoppingError)
    // Read-only methods keep working.
    expect(await h.service.list()).toHaveLength(1)

    // A successful restart reopens operations.
    await h.service.start()
    expect((await h.service.runNow(task.id)).status).toBe('succeeded')
    await h.service.stop()
  })

  it('stop() during an in-flight start() waits for it instead of returning early', async () => {
    const order: string[] = []
    const { lock } = makeRecordingLock(order)
    const h = makeService({ lock })
    // Hold the start mid-flight at the scheduler's storage load.
    let releaseLoad!: () => void
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve
    })
    const originalLoad = h.taskStorage.load.bind(h.taskStorage)
    ;(h.taskStorage as unknown as { load: () => Promise<unknown> }).load = async () => {
      await loadGate
      return originalLoad()
    }

    const starting = h.service.start()
    await new Promise((r) => setImmediate(r))

    const stopping = h.service.stop({ drainMs: 0 })
    let stopSettled = false
    stopping.then(
      () => { stopSettled = true },
      () => { stopSettled = true },
    )
    await new Promise((r) => setImmediate(r))
    // stop() must NOT settle while the start is still in flight — shutdown
    // cannot linearize before a start that is already acquiring the lock.
    expect(stopSettled).toBe(false)

    releaseLoad()
    await starting
    await stopping
    // The start completed and was THEN shut down: ops reject, lock released.
    await expect(h.service.create(everyMinute)).rejects.toBeInstanceOf(CronServiceStoppingError)
    expect(order[order.length - 1]).toBe('lock-release')
  })

  it('stopped is published only after lock release settles; the boundary holds for concurrent stop/start', async () => {
    const order: string[] = []
    let releaseRelease!: () => void
    const releaseGate = new Promise<void>((resolve) => {
      releaseRelease = resolve
    })
    let releases = 0
    const lock = {
      acquire: async () => {},
      release: async () => {
        await releaseGate
        releases += 1
        order.push('lock-release')
      },
    }
    const h = makeService({ lock })
    await h.service.start()

    const stopping = h.service.stop({ drainMs: 0 })
    let stopSettled = false
    stopping.then(
      () => { stopSettled = true },
      () => { stopSettled = true },
    )
    await new Promise((r) => setImmediate(r))

    // While the release is pending: the first stop has not settled...
    expect(stopSettled).toBe(false)
    // ...a concurrent second stop awaits the SAME outcome (not a no-op)...
    const second = h.service.stop({ drainMs: 0 })
    let secondSettled = false
    second.then(
      () => { secondSettled = true },
      () => { secondSettled = true },
    )
    await new Promise((r) => setImmediate(r))
    expect(secondSettled).toBe(false)
    // ...and start() cannot begin reacquiring the lock behind the boundary.
    await expect(h.service.start()).rejects.toBeInstanceOf(CronServiceStoppingError)

    releaseRelease()
    await Promise.all([stopping, second])
    expect(releases).toBe(1)

    // Only after the boundary settles is a restart allowed again.
    await h.service.start()
    expect((await h.service.create(everyMinute)).id).toBeTruthy()
    await h.service.stop()
    expect(releases).toBe(2)
  })

  it('a lock release failure is part of the shared stop outcome; the service stays non-accepting', async () => {
    const lock = {
      acquire: async () => {},
      release: async () => {
        throw new Error('release failed')
      },
    }
    const h = makeService({ lock })
    await h.service.start()

    await expect(h.service.stop({ drainMs: 0 })).rejects.toThrow('release failed')
    // Not a clean stopped: operations and lifecycle transitions stay
    // non-accepting rather than claiming shutdown completed.
    await expect(h.service.create(everyMinute)).rejects.toBeInstanceOf(CronServiceStoppingError)
    await expect(h.service.start()).rejects.toBeInstanceOf(CronServiceStoppingError)
    // A concurrent stop observes the SAME error outcome.
    await expect(h.service.stop({ drainMs: 0 })).rejects.toThrow('release failed')
  })

  it('a resume deferred behind stop() cannot resurrect the runtime — restart still works', async () => {
    const h = makeService({})
    await h.service.start()
    await h.service.suspend()

    // Hold the resume mid-flight at the scheduler's storage load.
    let releaseLoad!: () => void
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve
    })
    const originalLoad = h.taskStorage.load.bind(h.taskStorage)
    ;(h.taskStorage as unknown as { load: () => Promise<unknown> }).load = async () => {
      await loadGate
      return originalLoad()
    }

    const resuming = h.service.resume()
    await new Promise((r) => setImmediate(r))
    const stopping = h.service.stop({ drainMs: 0 })
    await new Promise((r) => setImmediate(r))

    releaseLoad()
    await resuming
    await stopping

    // The restart must ACTUALLY restart: a late runtime resume used to
    // overwrite the runtime's stopped state, making start() a silent no-op.
    await h.service.start()
    const task = await h.service.create(everyMinute)
    expect((await h.service.runNow(task.id)).status).toBe('succeeded')
    await h.service.stop()
  })

  it('a suspend deferred behind stop() cannot overwrite the stopped runtime', async () => {
    let releaseExecutor!: () => void
    const executorGate = new Promise<void>((resolve) => {
      releaseExecutor = resolve
    })
    let started = 0
    const executor: CronExecutor = async () => {
      started += 1
      await executorGate
      return { output: 'late' }
    }
    const h = makeService({ executor })
    await h.service.start()
    const task = await h.service.create(everyMinute)
    const run = h.service.runNow(task.id)
    await vi.waitFor(() => expect(started).toBe(1))

    // Hold the suspend mid-transition: the interrupt path's final
    // updateStatus write is gated.
    let releaseStatus!: () => void
    const statusGate = new Promise<void>((resolve) => {
      releaseStatus = resolve
    })
    const originalStatus = h.executionStore.updateStatus.bind(h.executionStore)
    ;(
      h.executionStore as unknown as {
        updateStatus: (...args: unknown[]) => Promise<unknown>
      }
    ).updateStatus = async (...args: unknown[]) => {
      await statusGate
      return originalStatus(...(args as never[]))
    }

    const suspending = h.service.suspend()
    await new Promise((r) => setImmediate(r))
    const stopping = h.service.stop({ drainMs: 0 })
    await new Promise((r) => setImmediate(r))

    releaseStatus()
    await suspending
    await stopping
    const result = await run
    expect(result.status).toBe('interrupted')

    releaseExecutor()
    // Restart works: the runtime was left stopped, not resurrected by the
    // late suspend completing after shutdown.
    await h.service.start()
    expect((await h.service.runNow(task.id)).status).toBe('succeeded')
    await h.service.stop()
  })

  it('stop() synchronously closes operation intake during an in-flight start()', async () => {
    const h = makeService({})
    // A pre-start task exists so the start's restart catch-up has a slot
    // that WOULD fire if intake were not closed at stop()-call time.
    const task = await h.service.create(everyMinute)

    let releaseLoad!: () => void
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve
    })
    const originalLoad = h.taskStorage.load.bind(h.taskStorage)
    ;(h.taskStorage as unknown as { load: () => Promise<unknown> }).load = async () => {
      await loadGate
      return originalLoad()
    }

    const starting = h.service.start()
    await new Promise((r) => setImmediate(r))

    const stopping = h.service.stop({ drainMs: 0 })
    // BEFORE anything settles: a protected operation called after stop()
    // must be rejected with the typed error — the shutdown boundary begins
    // at stop()-call time, not after the in-flight start finishes.
    await expect(h.service.create(everyMinute)).rejects.toBeInstanceOf(CronServiceStoppingError)
    let stopSettled = false
    stopping.then(
      () => { stopSettled = true },
      () => { stopSettled = true },
    )
    await new Promise((r) => setImmediate(r))
    expect(stopSettled).toBe(false)

    releaseLoad()
    await starting
    await stopping

    // No fire ever occurred: the start's restart catch-up of `task` was
    // dropped by the stopping intent, and the scheduler is now stopped.
    await h.timer.advance(10 * 60_000)
    expect(await h.service.listExecutions({ cronTaskId: task.id })).toEqual([])
  })

  it('a resume racing stop() submits no catch-up fire after shutdown was requested', async () => {
    let started = 0
    const executor: CronExecutor = async () => {
      started += 1
      return { output: 'x' }
    }
    const h = makeService({ executor })
    await h.service.start()
    const task = await h.service.create(everyMinute)
    await h.service.suspend()
    await h.timer.advance(5 * 60_000) // missed slots accumulate while suspended

    let releaseLoad!: () => void
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve
    })
    const originalLoad = h.taskStorage.load.bind(h.taskStorage)
    ;(h.taskStorage as unknown as { load: () => Promise<unknown> }).load = async () => {
      await loadGate
      return originalLoad()
    }

    const resuming = h.service.resume()
    await new Promise((r) => setImmediate(r))
    const stopping = h.service.stop({ drainMs: 0 })

    releaseLoad()
    await resuming
    await stopping

    // The resume completed, but its catch-up of the missed slots was
    // dropped: shutdown was requested before any fire could be submitted.
    expect(started).toBe(0)
    expect(await h.service.listExecutions({ cronTaskId: task.id })).toEqual([])

    // The intent is cleared once shutdown settles: a restart fires
    // normally again (its own catch-up of the missed slot runs).
    await h.service.start()
    await vi.waitFor(async () => {
      const execs = await h.service.listExecutions({ cronTaskId: task.id })
      expect(execs.some((e) => e.status === 'succeeded')).toBe(true)
    })
    await h.service.stop()
  })
})

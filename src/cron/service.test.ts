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

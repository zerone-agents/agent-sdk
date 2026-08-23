import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FakeClock, ManualTimer } from '../clock.js'
import type { Agent } from '../../agent.js'
import type { AgentOptions } from '../../types.js'
import { createDefaultCronService } from './default.js'

let dataDir: string

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'cron-sdk-default-'))
})

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

function makeFakeAgent(log: string[]) {
  return (_options: AgentOptions): Agent =>
    ({
      query: async function* (prompt: string) {
        log.push(`query:${prompt}`)
        yield {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: `ran:${prompt}` }] },
        }
      },
      close: async () => { log.push('close') },
    }) as unknown as Agent
}

function makeContext() {
  return {
    clock: new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0)),
    log: [] as string[],
  }
}

describe('createDefaultCronService', () => {
  it('wires FileCronStorage + FileExecutionStore under <dataDir>/cron', async () => {
    const { clock, log } = makeContext()
    const timer = new ManualTimer(clock)
    const service = createDefaultCronService({
      dataDir,
      resolveAgent: async () => ({}),
      createAgentFn: makeFakeAgent(log),
      clock,
      timer,
    })
    await service.start()

    const task = await service.create({ cron: '* * * * *', prompt: 'run report' })
    const execution = await service.runNow(task.id)

    expect(execution.status).toBe('succeeded')
    expect(execution.output).toBe('ran:run report')
    // File persistence exists
    const cronDir = path.join(dataDir, 'cron')
    await expect(
      import('node:fs/promises').then((fs) => fs.access(path.join(cronDir, 'tasks.json'))),
    ).resolves.toBeUndefined()
    await expect(
      import('node:fs/promises').then((fs) => fs.access(path.join(cronDir, 'executions.jsonl'))),
    ).resolves.toBeUndefined()
    await service.stop()
  })

  it('fires scheduled executions by advancing the injected timer (closed loop)', async () => {
    const { clock, log } = makeContext()
    const timer = new ManualTimer(clock)
    const service = createDefaultCronService({
      dataDir,
      resolveAgent: async () => ({}),
      createAgentFn: makeFakeAgent(log),
      clock,
      timer,
    })
    await service.start()
    const task = await service.create({ cron: '* * * * *', prompt: 'tick' })

    await timer.advance(60_000 + 6_000)

    // Scheduled fires are fire-and-forget; the file-backed submit chain
    // floats after the advance, so poll (real timers, fast fs) — no sleeps.
    await vi.waitFor(async () => {
      const executions = await service.listExecutions({ cronTaskId: task.id })
      expect(executions).toHaveLength(1)
      expect(executions[0]).toMatchObject({ status: 'succeeded', output: 'ran:tick' })
    })
    expect(log).toContain('close')
    const after = await service.get(task.id)
    expect(after?.lastFiredAt).toBeDefined()
    await service.stop()
  })

  it('catches up at most once after suspend/resume with downtime', async () => {
    const { clock, log } = makeContext()
    const timer = new ManualTimer(clock)
    const service = createDefaultCronService({
      dataDir,
      resolveAgent: async () => ({}),
      createAgentFn: makeFakeAgent(log),
      clock,
      timer,
    })
    await service.start()
    const task = await service.create({ cron: '* * * * *', prompt: 'tick' })

    await service.suspend()
    clock.set(clock.now() + 5 * 60_000) // 5 minutes of system sleep, no timers
    await service.resume()

    // The catch-up fire floats (fire-and-forget); poll for its completion.
    await vi.waitFor(async () => {
      const executions = await service.listExecutions({ cronTaskId: task.id })
      expect(executions).toHaveLength(1)
      expect(executions[0]!.status).toBe('succeeded')
    })
    await service.stop()
  })

  it('a second start() on a running service keeps the lock held', async () => {
    const { clock, log } = makeContext()
    const serviceA = createDefaultCronService({
      dataDir,
      resolveAgent: async () => ({}),
      createAgentFn: makeFakeAgent(log),
      clock,
      timer: new ManualTimer(clock),
    })
    await serviceA.start()

    // Double start: no error, and the live lock must stay held.
    await expect(serviceA.start()).resolves.toBeUndefined()

    const b = makeContext()
    const serviceB = createDefaultCronService({
      dataDir,
      resolveAgent: async () => ({}),
      createAgentFn: makeFakeAgent(b.log),
      clock: b.clock,
      timer: new ManualTimer(b.clock),
    })
    // If the double start had released the lock, serviceB would now start.
    await expect(serviceB.start()).rejects.toThrow(/already running/)
    await expect(serviceB.stop()).resolves.toBeUndefined()

    await serviceA.stop()
  })

  it('prevents a second runtime on the same directory', async () => {
    const a = makeContext()
    const timerA = new ManualTimer(a.clock)
    const serviceA = createDefaultCronService({
      dataDir,
      resolveAgent: async () => ({}),
      createAgentFn: makeFakeAgent(a.log),
      clock: a.clock,
      timer: timerA,
    })
    await serviceA.start()

    const b = makeContext()
    const timerB = new ManualTimer(b.clock)
    const serviceB = createDefaultCronService({
      dataDir,
      resolveAgent: async () => ({}),
      createAgentFn: makeFakeAgent(b.log),
      clock: b.clock,
      timer: timerB,
    })
    await expect(serviceB.start()).rejects.toThrow(/already running/)
    await expect(serviceB.stop()).resolves.toBeUndefined()

    await serviceA.stop()
    // lock released: a fresh runtime can start now
    const c = makeContext()
    const serviceC = createDefaultCronService({
      dataDir,
      resolveAgent: async () => ({}),
      createAgentFn: makeFakeAgent(c.log),
      clock: c.clock,
      timer: new ManualTimer(c.clock),
    })
    await expect(serviceC.start()).resolves.toBeUndefined()
    await serviceC.stop()
  })

  it('recovers crashed running executions on restart', async () => {
    // Seed a leftover pending record directly through the store.
    const { FileExecutionStore } = await import('./file-execution-store.js')
    const seed = new FileExecutionStore(path.join(dataDir, 'cron'))
    const { execution } = await seed.claim({
      taskId: 't-crash',
      scheduledFireTime: 1,
      trigger: 'scheduled',
    })
    expect(execution.status).toBe('pending')

    const { clock, log } = makeContext()
    const service = createDefaultCronService({
      dataDir,
      resolveAgent: async () => ({}),
      createAgentFn: makeFakeAgent(log),
      clock,
      timer: new ManualTimer(clock),
    })
    await service.start()

    const recovered = await service.getExecution(execution.id)
    expect(recovered).toMatchObject({ status: 'interrupted' })
    await service.stop()
  })

  it('resolves the agent fresh on every fire', async () => {
    const { clock, log } = makeContext()
    const resolveAgent = vi.fn(async () => ({}))
    const service = createDefaultCronService({
      dataDir,
      resolveAgent,
      createAgentFn: makeFakeAgent(log),
      clock,
      timer: new ManualTimer(clock),
    })
    await service.start()
    const task = await service.create({ cron: '* * * * *', prompt: 'x' })

    await service.runNow(task.id)
    // Distinct manual fire time (clock advanced by 1ms) and the first
    // execution already completed -> the second is claimed, not duplicate/skipped.
    clock.set(clock.now() + 1)
    await service.runNow(task.id)

    expect(resolveAgent).toHaveBeenCalledTimes(2)
    await service.stop()
  })
})

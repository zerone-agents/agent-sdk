import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, readFile, appendFile, writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { withCronMaintenanceSession } from './maintenance.js'
import type { CronMaintenanceService } from './maintenance.js'
import { createDefaultCronService } from './default.js'
import { FileExecutionStore } from './file-execution-store.js'
import type { Agent } from '../../agent.js'
import type { AgentOptions } from '../../types.js'

/**
 * Issue #52 acceptance matrix: a locked, callback-scoped maintenance session
 * over the same directory the online Runtime uses — CRUD + history access,
 * never a Scheduler/Executor, never startup recovery.
 */

let dataDir: string

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'cron-maint-'))
})

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

function fakeAgent(): (options: AgentOptions) => Agent {
  return () =>
    ({
      query: async function* (_prompt: string) {
        yield {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'final text' }] },
        }
      },
      close: async () => {},
    }) as unknown as Agent
}

function makeOnlineService(dataDirOverride?: string) {
  return createDefaultCronService({
    dataDir: dataDirOverride ?? dataDir,
    resolveAgent: async () => ({}) as AgentOptions,
    createAgentFn: fakeAgent(),
  })
}

function deferred<T = void>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('withCronMaintenanceSession (issue #52)', () => {
  it('maintenance CRUD persists tasks a subsequently started default CronService can read', async () => {
    let taskId: string | undefined
    await withCronMaintenanceSession({ dataDir }, async (service) => {
      const task = await service.create({ cron: '0 16 * * *', prompt: 'run report', name: 'report' })
      taskId = task.id
      const updated = await service.update(task.id, { prompt: 'run the weekly report' })
      expect(updated).toMatchObject({ id: task.id, prompt: 'run the weekly report' })
    })

    const online = makeOnlineService()
    await online.start()
    try {
      const tasks = await online.list()
      expect(tasks).toHaveLength(1)
      expect(tasks[0]).toMatchObject({
        id: taskId,
        cron: '0 16 * * *',
        prompt: 'run the weekly report',
        name: 'report',
      })
    } finally {
      await online.stop({ drainMs: 0 })
    }
  })

  it('execution history written by a Runtime is queryable in a later maintenance session', async () => {
    const online = makeOnlineService()
    let executionId: string | undefined
    await online.start()
    try {
      const task = await online.create({ cron: '0 16 * * *', prompt: 'run' })
      const execution = await online.runNow(task.id)
      executionId = execution.id
    } finally {
      await online.stop({ drainMs: 0 })
    }

    await withCronMaintenanceSession({ dataDir }, async (service) => {
      const executions = await service.listExecutions()
      expect(executions.some((e) => e.id === executionId && e.trigger === 'manual')).toBe(true)
      expect(await service.getExecution(executionId!)).toMatchObject({
        id: executionId,
        trigger: 'manual',
      })
    })
  })

  it('maintenance session refuses while a default CronService holds the directory lock', async () => {
    const online = makeOnlineService()
    await online.start()
    try {
      await expect(withCronMaintenanceSession({ dataDir }, async () => {})).rejects.toThrow(
        /already running/,
      )
    } finally {
      await online.stop({ drainMs: 0 })
    }
  })

  it('default CronService refuses to start while a maintenance session holds the lock', async () => {
    const acquired = deferred()
    const gate = deferred()
    const session = withCronMaintenanceSession({ dataDir }, async () => {
      acquired.resolve()
      await gate.promise
    })
    await acquired.promise // lock definitively held by the session

    const online = makeOnlineService()
    await expect(online.start()).rejects.toThrow(/already running/)

    gate.resolve()
    await session
    // After release the same online service starts cleanly.
    await online.start()
    await online.stop({ drainMs: 0 })
  })

  it('two maintenance sessions cannot overlap on the same directory', async () => {
    const acquired = deferred()
    const gate = deferred()
    const first = withCronMaintenanceSession({ dataDir }, async () => {
      acquired.resolve()
      await gate.promise
    })
    await acquired.promise

    await expect(withCronMaintenanceSession({ dataDir }, async () => {})).rejects.toThrow(
      /already running/,
    )

    gate.resolve()
    await first
  })

  it('different data directories can be maintained concurrently', async () => {
    const dirA = await mkdtemp(join(tmpdir(), 'cron-maint-a-'))
    const dirB = await mkdtemp(join(tmpdir(), 'cron-maint-b-'))
    try {
      await Promise.all([
        withCronMaintenanceSession({ dataDir: dirA }, async (service) => {
          await service.create({ cron: '0 16 * * *', prompt: 'a' })
        }),
        withCronMaintenanceSession({ dataDir: dirB }, async (service) => {
          await service.create({ cron: '30 8 * * *', prompt: 'b' })
        }),
      ])
    } finally {
      await rm(dirA, { recursive: true, force: true })
      await rm(dirB, { recursive: true, force: true })
    }
  })

  it('a due task creates no execution records — no Scheduler timer or Executor runs', async () => {
    await withCronMaintenanceSession({ dataDir }, async (service) => {
      // '* * * * *' is due within a minute; the inert scheduler must never fire
      const task = await service.create({ cron: '* * * * *', prompt: 'due now' })
      expect(await service.listExecutions({ cronTaskId: task.id })).toEqual([])
    })
    // Still nothing after the session ends.
    await withCronMaintenanceSession({ dataDir }, async (service) => {
      expect(await service.listExecutions()).toEqual([])
    })
  })

  it('missed tasks are not executed and leftover pending records are NOT recovered', async () => {
    // Seed a crashed-Runtime leftover: a claimed-but-never-completed record.
    const cronDir = join(dataDir, 'cron')
    await mkdir(cronDir, { recursive: true })
    const seed = new FileExecutionStore(cronDir)
    const claimed = await seed.claim({
      taskId: 't-leftover',
      scheduledFireTime: 60_000,
      trigger: 'scheduled',
    })

    await withCronMaintenanceSession({ dataDir }, async (service) => {
      // Missed/overdue schedule: never executed during maintenance.
      const task = await service.create({ cron: '* * * * *', prompt: 'missed' })
      expect(await service.listExecutions({ cronTaskId: task.id })).toEqual([])
      // The leftover pending record is still pending — recovery stays owned
      // by the real Runtime's start(); maintenance never flips it.
      expect(await service.getExecution(claimed.execution.id)).toMatchObject({
        status: 'pending',
      })
    })

    // A second session observes the same: still not recovered.
    await withCronMaintenanceSession({ dataDir }, async (service) => {
      expect(await service.getExecution(claimed.execution.id)).toMatchObject({
        status: 'pending',
      })
    })
  })

  it('callback rejection still releases the lock', async () => {
    const sentinel = new Error('boom')
    await expect(
      withCronMaintenanceSession({ dataDir }, async () => {
        throw sentinel
      }),
    ).rejects.toBe(sentinel)

    // Lock was released despite the rejection: an online service starts.
    const online = makeOnlineService()
    await online.start()
    await online.stop({ drainMs: 0 })
  })

  it('task validation matches the default service', async () => {
    await expect(
      withCronMaintenanceSession({ dataDir }, async (service) => {
        await service.create({ cron: 'not-a-cron', prompt: 'x' })
      }),
    ).rejects.toThrow(/Invalid cron expression/)

    const online = makeOnlineService()
    await expect(online.create({ cron: 'not-a-cron', prompt: 'x' })).rejects.toThrow(
      /Invalid cron expression/,
    )
  })

  it('incomplete execution-log tail is tolerated like the normal file store', async () => {
    const cronDir = join(dataDir, 'cron')
    await mkdir(cronDir, { recursive: true })
    const seed = new FileExecutionStore(cronDir)
    const claimed = await seed.claim({
      taskId: 't1',
      scheduledFireTime: 60_000,
      trigger: 'scheduled',
    })
    // Crash mid-append: a truncated JSON line at the very end of the log.
    await appendFile(join(cronDir, 'executions.jsonl'), '{"id":"truncated","status":')

    await withCronMaintenanceSession({ dataDir }, async (service) => {
      const list = await service.listExecutions()
      expect(list.some((e) => e.id === claimed.execution.id)).toBe(true)
    })
  })

  it('mid-log corruption refuses like the normal file store', async () => {
    const cronDir = join(dataDir, 'cron')
    await mkdir(cronDir, { recursive: true })
    const seed = new FileExecutionStore(cronDir)
    const claimed = await seed.claim({
      taskId: 't1',
      scheduledFireTime: 60_000,
      trigger: 'scheduled',
    })
    // Rewrite the log with a garbage line BETWEEN valid records, and drop the
    // rebuildable index so reads must replay the log.
    const logPath = join(cronDir, 'executions.jsonl')
    const lines = (await readFile(logPath, 'utf8')).split('\n').filter((l) => l.trim() !== '')
    expect(lines.length).toBeGreaterThanOrEqual(1)
    const corrupted = [lines[0], '{"id":"mid","broken":', ...lines.slice(1)].join('\n') + '\n'
    await writeFile(logPath, corrupted)
    await unlink(join(cronDir, 'execution-index.json')).catch(() => {})

    await expect(
      withCronMaintenanceSession({ dataDir }, async (service) => {
        await service.getExecution(claimed.execution.id)
      }),
    ).rejects.toThrow(/replay|recreate|corrupt/i)
  })

  it('a service reference retained outside the callback is refused after the session ends', async () => {
    let retained: CronMaintenanceService | undefined
    await withCronMaintenanceSession({ dataDir }, async (service) => {
      retained = service
      await service.create({ cron: '0 16 * * *', prompt: 'works inside' })
    })
    const ref = retained!
    await expect(ref.create({ cron: '0 16 * * *', prompt: 'y' })).rejects.toThrow(
      /session has ended/,
    )
    await expect(ref.list()).rejects.toThrow(/session has ended/)
    await expect(ref.get('any')).rejects.toThrow(/session has ended/)
    await expect(ref.update('any', {})).rejects.toThrow(/session has ended/)
    await expect(ref.delete('any')).rejects.toThrow(/session has ended/)
    await expect(ref.listExecutions()).rejects.toThrow(/session has ended/)
    await expect(ref.getExecution('any')).rejects.toThrow(/session has ended/)
  })
})

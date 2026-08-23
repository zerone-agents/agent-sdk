import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ExecutionLog } from './execution-log.js'
import type { CronExecution } from '../types.js'

let dir: string
let log: ExecutionLog

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cron-sdk-log-'))
  log = new ExecutionLog(path.join(dir, 'executions.jsonl'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

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

describe('ExecutionLog', () => {
  it('replays an empty result when the file is missing', async () => {
    const result = await log.replay()
    expect(result.executions.size).toBe(0)
    expect(result.seq).toBe(0)
    expect(result.diagnostics).toEqual([])
  })

  it('appends records and replays them, last snapshot per id wins', async () => {
    await log.append(1, execution())
    await log.append(2, execution({ status: 'running', startedAt: 5 }))
    await log.append(3, execution({ id: 'e2', status: 'succeeded' }))

    const result = await log.replay()

    expect(result.seq).toBe(3)
    expect(result.executions.get('e1')).toMatchObject({ status: 'running', startedAt: 5 })
    expect(result.executions.get('e2')).toMatchObject({ status: 'succeeded' })
  })

  it('ignores an incomplete trailing record and reports a diagnostic', async () => {
    await log.append(1, execution())
    const filePath = path.join(dir, 'executions.jsonl')
    const { appendFile } = await import('node:fs/promises')
    await appendFile(filePath, '{"seq":2,"execution":{"id":"e2","cronTaskId":"t1","sched', 'utf8')

    const result = await log.replay()

    expect(result.executions.size).toBe(1)
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]).toMatch(/line 2/)
  })

  it('refuses to start on mid-log corruption', async () => {
    await log.append(1, execution())
    await log.append(2, execution({ id: 'e2' }))
    const filePath = path.join(dir, 'executions.jsonl')
    const text = await import('node:fs/promises').then((fs) => fs.readFile(filePath, 'utf8'))
    const lines = text.split('\n')
    lines[1] = 'garbage not json'
    await writeFile(filePath, lines.join('\n'), 'utf8')

    await expect(log.replay()).rejects.toThrow(/corrupted at line 2/)
  })

  it('rejects structurally invalid records mid-log', async () => {
    const filePath = path.join(dir, 'executions.jsonl')
    const bad = JSON.stringify({ seq: 1, execution: { id: 'x', status: 'not-a-status' } })
    await writeFile(filePath, `${bad}\n`, 'utf8')

    await expect(log.replay()).rejects.toThrow(/corrupted at line 1/)
  })
})

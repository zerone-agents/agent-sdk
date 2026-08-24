import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FileExecutionStore } from './file-execution-store.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cron-sdk-store-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('FileExecutionStore', () => {
  it('claims a new execution as pending', async () => {
    const store = new FileExecutionStore(dir)
    const result = await store.claim({ taskId: 't1', scheduledFireTime: 60_000, trigger: 'scheduled' })
    expect(result.kind).toBe('claimed')
    expect(result.execution).toMatchObject({ cronTaskId: 't1', status: 'pending' })
  })

  it('returns duplicate for the same (taskId, fireTime) — even after terminal state', async () => {
    const store = new FileExecutionStore(dir)
    const first = await store.claim({ taskId: 't1', scheduledFireTime: 60_000, trigger: 'scheduled' })
    await store.updateStatus(first.execution.id, 'succeeded', { output: 'ok' })

    const second = await store.claim({ taskId: 't1', scheduledFireTime: 60_000, trigger: 'scheduled' })

    expect(second.kind).toBe('duplicate')
    if (second.kind === 'duplicate') expect(second.execution.id).toBe(first.execution.id)
  })

  it('dedups independently per task at the same fire time', async () => {
    const store = new FileExecutionStore(dir)
    const a = await store.claim({ taskId: 't1', scheduledFireTime: 60_000, trigger: 'scheduled' })
    const b = await store.claim({ taskId: 't2', scheduledFireTime: 60_000, trigger: 'scheduled' })
    expect(a.kind).toBe('claimed')
    expect(b.kind).toBe('claimed')
  })

  it('records skipped while the task has an active execution, then allows claims after terminal', async () => {
    const store = new FileExecutionStore(dir)
    const active = await store.claim({ taskId: 't1', scheduledFireTime: 60_000, trigger: 'scheduled' })

    const skipped = await store.claim({ taskId: 't1', scheduledFireTime: 120_000, trigger: 'manual' })
    expect(skipped.kind).toBe('skipped')

    await store.updateStatus(active.execution.id, 'succeeded', {})

    const next = await store.claim({ taskId: 't1', scheduledFireTime: 180_000, trigger: 'scheduled' })
    expect(next.kind).toBe('claimed')
  })

  it('updateStatus merges patches and returns the record', async () => {
    const store = new FileExecutionStore(dir)
    const { execution } = await store.claim({ taskId: 't1', scheduledFireTime: 60_000, trigger: 'scheduled' })

    const running = await store.updateStatus(execution.id, 'running', { startedAt: 5 })
    const done = await store.updateStatus(execution.id, 'succeeded', { output: 'x', completedAt: 9 })

    expect(running).toMatchObject({ status: 'running', startedAt: 5 })
    expect(done).toMatchObject({ status: 'succeeded', output: 'x', completedAt: 9 })
    expect(await store.updateStatus('missing', 'failed', {})).toBeNull()
  })

  it('lists sorted by fire time desc with filters and paging', async () => {
    const store = new FileExecutionStore(dir)
    for (const time of [60_000, 120_000, 180_000]) {
      await store.claim({ taskId: 't1', scheduledFireTime: time, trigger: 'scheduled' })
    }
    await store.claim({ taskId: 't2', scheduledFireTime: 90_000, trigger: 'manual' })

    const all = await store.list()
    expect(all.map((e) => e.scheduledFireTime)).toEqual([180_000, 120_000, 90_000, 60_000])

    const filtered = await store.list({ cronTaskId: 't1' })
    expect(filtered).toHaveLength(3)

    const paged = await store.list({ limit: 2, offset: 1 })
    expect(paged.map((e) => e.scheduledFireTime)).toEqual([120_000, 90_000])
  })

  it('recovers leftover pending/running records as interrupted on a new instance', async () => {
    const a = new FileExecutionStore(dir)
    const pending = await a.claim({ taskId: 't1', scheduledFireTime: 60_000, trigger: 'scheduled' })
    const running = await a.claim({ taskId: 't2', scheduledFireTime: 60_000, trigger: 'scheduled' })
    await a.updateStatus(running.execution.id, 'running', {})
    // simulate crash: no terminal status written

    const b = new FileExecutionStore(dir)
    const count = await b.recoverInterrupted()

    expect(count).toBe(2)
    expect(await b.get(pending.execution.id)).toMatchObject({ status: 'interrupted' })
    expect(await b.get(running.execution.id)).toMatchObject({ status: 'interrupted' })
  })

  it('persists dedup across restarts', async () => {
    const a = new FileExecutionStore(dir)
    const first = await a.claim({ taskId: 't1', scheduledFireTime: 60_000, trigger: 'scheduled' })
    await a.updateStatus(first.execution.id, 'succeeded', {})

    const b = new FileExecutionStore(dir)
    const again = await b.claim({ taskId: 't1', scheduledFireTime: 60_000, trigger: 'scheduled' })

    expect(again.kind).toBe('duplicate')
  })

  it('reports torn-tail replay diagnostics via onDiagnostic and still functions', async () => {
    const a = new FileExecutionStore(dir)
    const first = await a.claim({ taskId: 't1', scheduledFireTime: 60_000, trigger: 'scheduled' })
    await a.updateStatus(first.execution.id, 'succeeded', {})

    // Manually append a truncated JSON line (torn tail from a crash mid-write),
    // reusing the corruption pattern from execution-log.test.ts.
    const { appendFile } = await import('node:fs/promises')
    await appendFile(
      path.join(dir, 'executions.jsonl'),
      '{"seq":2,"execution":{"id":"e2","cronTaskId":"t1","sched',
      'utf8',
    )

    const onDiagnostic = vi.fn()
    const b = new FileExecutionStore(dir, { onDiagnostic })

    // First operation triggers the replay which reports the torn tail.
    const claim = await b.claim({ taskId: 't1', scheduledFireTime: 120_000, trigger: 'scheduled' })

    expect(onDiagnostic).toHaveBeenCalled()
    expect(onDiagnostic.mock.calls[0]![0]).toMatch(/incomplete trailing record/)
    // State is unaffected: the store still functions and prior state is intact.
    expect(claim.kind).toBe('claimed')
    expect(await b.get(first.execution.id)).toMatchObject({ status: 'succeeded' })
  })

  it('rebuilds state from the log when execution-index.json is deleted', async () => {
    const a = new FileExecutionStore(dir)
    const first = await a.claim({ taskId: 't1', scheduledFireTime: 60_000, trigger: 'scheduled' })
    await a.updateStatus(first.execution.id, 'succeeded', { output: 'ok' })
    await rm(path.join(dir, 'execution-index.json'), { force: true })

    const b = new FileExecutionStore(dir)
    const record = await b.get(first.execution.id)

    expect(record).toMatchObject({ status: 'succeeded', output: 'ok' })
  })

  it('retries the load after a transient replay failure instead of caching the rejection', async () => {
    const logPath = path.join(dir, 'executions.jsonl')
    const store = new FileExecutionStore(dir)
    // Prime the log file so it exists, then make it unreadable.
    await store.claim({ taskId: 't1', scheduledFireTime: 60_000, trigger: 'scheduled' })
    await chmod(logPath, 0o000)

    const failing = new FileExecutionStore(dir)
    await expect(
      failing.claim({ taskId: 't2', scheduledFireTime: 120_000, trigger: 'scheduled' }),
    ).rejects.toThrow()

    // Restore readability: the next call must retry (and succeed), not re-throw
    // the memoized rejection.
    await chmod(logPath, 0o644)
    const retried = await failing.claim({ taskId: 't2', scheduledFireTime: 120_000, trigger: 'scheduled' })
    expect(retried.kind).toBe('claimed')
  })
})

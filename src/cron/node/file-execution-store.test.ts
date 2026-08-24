import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises'
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

    const skipped = await store.claim({
      taskId: 't1',
      scheduledFireTime: 120_000,
      trigger: 'manual',
      dedupKey: 'manual:skip-1',
    })
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
    await store.claim({ taskId: 't2', scheduledFireTime: 90_000, trigger: 'manual', dedupKey: 'manual:list-1' })

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

  it('a completed manual claim does not block a scheduled claim at the same fire time', async () => {
    const store = new FileExecutionStore(dir)
    const time = 60_000
    const manual = await store.claim({
      taskId: 't1',
      scheduledFireTime: time,
      trigger: 'manual',
      dedupKey: 'manual:xxx',
    })
    expect(manual.kind).toBe('claimed')
    await store.updateStatus(manual.execution.id, 'succeeded', {})

    // updateStatus must not register the manual record under the DEFAULT
    // (taskId:fireTime) identity — the scheduled slot at the same time is free.
    const scheduled = await store.claim({ taskId: 't1', scheduledFireTime: time, trigger: 'scheduled' })
    expect(scheduled.kind).toBe('claimed')
  })

  it('a completed manual claim does not block a scheduled claim at the same fire time after restart', async () => {
    const a = new FileExecutionStore(dir)
    const time = 60_000
    const manual = await a.claim({
      taskId: 't1',
      scheduledFireTime: time,
      trigger: 'manual',
      dedupKey: 'manual:xxx',
    })
    expect(manual.kind).toBe('claimed')
    await a.updateStatus(manual.execution.id, 'succeeded', {})

    // Replay must derive no DEFAULT identity for manual records.
    const b = new FileExecutionStore(dir)
    const scheduled = await b.claim({ taskId: 't1', scheduledFireTime: time, trigger: 'scheduled' })
    expect(scheduled.kind).toBe('claimed')
  })

  it('a manual claim is still skipped while the task has an active manual execution at the same fire time', async () => {
    const store = new FileExecutionStore(dir)
    const time = 60_000
    const first = await store.claim({
      taskId: 't1',
      scheduledFireTime: time,
      trigger: 'manual',
      dedupKey: 'manual:a',
    })
    expect(first.kind).toBe('claimed')

    const second = await store.claim({
      taskId: 't1',
      scheduledFireTime: time,
      trigger: 'manual',
      dedupKey: 'manual:b',
    })
    expect(second.kind).toBe('skipped')
  })

  it('a pending manual execution from a previous process still blocks a new claim after restart', async () => {
    const a = new FileExecutionStore(dir)
    const manual = await a.claim({
      taskId: 't1',
      scheduledFireTime: 60_000,
      trigger: 'manual',
      dedupKey: 'manual:abc',
    })
    expect(manual.kind).toBe('claimed')
    // simulate crash: no terminal status written, no recoverInterrupted()

    // The at-most-one-active guarantee is trigger-agnostic: replay must rebuild
    // activeByTask for manual records too, or a fresh store would accept a
    // second active execution for the same task.
    const b = new FileExecutionStore(dir)
    const again = await b.claim({
      taskId: 't1',
      scheduledFireTime: 120_000,
      trigger: 'manual',
      dedupKey: 'manual:def',
    })
    expect(again.kind).toBe('skipped')
  })

  it('a running manual execution from a previous process still blocks a scheduled claim after restart', async () => {
    const a = new FileExecutionStore(dir)
    const manual = await a.claim({
      taskId: 't1',
      scheduledFireTime: 60_000,
      trigger: 'manual',
      dedupKey: 'manual:abc',
    })
    await a.updateStatus(manual.execution.id, 'running', { startedAt: 60_000 })
    // simulate crash mid-run

    const b = new FileExecutionStore(dir)
    const blocked = await b.claim({ taskId: 't1', scheduledFireTime: 120_000, trigger: 'scheduled' })
    expect(blocked.kind).toBe('skipped')

    // recoverInterrupted() clears the rebuilt active entry; claims resume.
    await b.recoverInterrupted()
    const after = await b.claim({ taskId: 't1', scheduledFireTime: 180_000, trigger: 'scheduled' })
    expect(after.kind).toBe('claimed')
  })

  it('rejects a manual claim without a dedupKey instead of silently keying it by time', async () => {
    const store = new FileExecutionStore(dir)
    // JS/host callers bypassing the compile-time union must be refused: a
    // manual claim keyed by time would occupy the DEFAULT identity in-process
    // while replay derives none for manual records — cross-restart dedup would
    // silently diverge. The guard makes the divergence loud instead.
    const legacyInput = { taskId: 't1', scheduledFireTime: 60_000, trigger: 'manual' as const }
    await expect(store.claim(legacyInput as never)).rejects.toThrow(/dedupKey/)
  })

  it('rejects a claim with an unknown trigger instead of treating it as scheduled', async () => {
    const store = new FileExecutionStore(dir)
    // A JS/host caller passing trigger: 'bogus' would fall into the `else`
    // (scheduled) path: the record would be registered in byFire while replay
    // only rebuilds byFire for exact 'scheduled' — silently changing the
    // permanent-dedup semantics across a restart. Reject at the boundary.
    const bogus = { taskId: 't1', scheduledFireTime: 60_000, trigger: 'bogus' }
    await expect(store.claim(bogus as never)).rejects.toThrow(/trigger/)
    // Nothing was persisted or indexed.
    expect(await store.list()).toEqual([])
  })

  it('rejects a scheduled claim carrying a dedupKey', async () => {
    const store = new FileExecutionStore(dir)
    const input = {
      taskId: 't1',
      scheduledFireTime: 60_000,
      trigger: 'scheduled' as const,
      dedupKey: 'custom',
    }
    await expect(store.claim(input as never)).rejects.toThrow(/dedupKey/)
  })

  it('rejects a manual claim with a null dedupKey (?? must not fall back to the DEFAULT identity)', async () => {
    const store = new FileExecutionStore(dir)
    const input = {
      taskId: 't1',
      scheduledFireTime: 60_000,
      trigger: 'manual' as const,
      dedupKey: null,
    }
    await expect(store.claim(input as never)).rejects.toThrow(/dedupKey/)
  })

  it('rejects a manual claim with an empty dedupKey (submissions must not collapse onto one key)', async () => {
    const store = new FileExecutionStore(dir)
    await expect(
      store.claim({ taskId: 't1', scheduledFireTime: 60_000, trigger: 'manual', dedupKey: '' }),
    ).rejects.toThrow(/dedupKey/)
  })

  it('a manual dedupKey textually equal to a scheduled DEFAULT key never collides', async () => {
    const store = new FileExecutionStore(dir)
    // Adversarial but type-legal input: the custom key text matches `t1:60000`.
    const manual = await store.claim({
      taskId: 't1',
      scheduledFireTime: 60_000,
      trigger: 'manual',
      dedupKey: 't1:60000',
    })
    expect(manual.kind).toBe('claimed')
    // Reach a terminal state so activeByTask does not mask the dedup check.
    await store.updateStatus(manual.execution.id, 'succeeded', {})

    // The manual run must NOT occupy the scheduled DEFAULT identity.
    const scheduled = await store.claim({ taskId: 't1', scheduledFireTime: 60_000, trigger: 'scheduled' })
    expect(scheduled.kind).toBe('claimed')
  })

  it('a scheduled DEFAULT claim never collides with a later manual dedupKey of the same text', async () => {
    const store = new FileExecutionStore(dir)
    const scheduled = await store.claim({ taskId: 't1', scheduledFireTime: 60_000, trigger: 'scheduled' })
    expect(scheduled.kind).toBe('claimed')

    // Different task id so activeByTask does not mask the dedup check.
    const manual = await store.claim({
      taskId: 't2',
      scheduledFireTime: 90_000,
      trigger: 'manual',
      dedupKey: 't1:60000',
    })
    expect(manual.kind).toBe('claimed')
  })

  it('re-claiming the same manual dedupKey is a duplicate while in-process dedup applies', async () => {
    const store = new FileExecutionStore(dir)
    const first = await store.claim({
      taskId: 't1',
      scheduledFireTime: 60_000,
      trigger: 'manual',
      dedupKey: 'manual:same',
    })
    expect(first.kind).toBe('claimed')
    await store.updateStatus(first.execution.id, 'succeeded', {})

    // The custom identity is registered at claim time; its dedup survives
    // the manual record reaching a terminal state within this process.
    const again = await store.claim({
      taskId: 't1',
      scheduledFireTime: 60_000,
      trigger: 'manual',
      dedupKey: 'manual:same',
    })
    expect(again.kind).toBe('duplicate')
    if (again.kind === 'duplicate') expect(again.execution.id).toBe(first.execution.id)
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

  it('a throwing onDiagnostic during torn-tail replay does not break loading', async () => {
    const a = new FileExecutionStore(dir)
    const first = await a.claim({ taskId: 't1', scheduledFireTime: 60_000, trigger: 'scheduled' })
    await a.updateStatus(first.execution.id, 'succeeded', {})

    const { appendFile } = await import('node:fs/promises')
    await appendFile(
      path.join(dir, 'executions.jsonl'),
      '{"seq":2,"execution":{"id":"e2","cronTaskId":"t1","sched',
      'utf8',
    )

    const b = new FileExecutionStore(dir, {
      onDiagnostic: () => { throw new Error('diagnostics exploded') },
    })

    // The broken diagnostics sink must not break the replay: the store loads
    // and claims normally, prior state intact.
    const claim = await b.claim({ taskId: 't1', scheduledFireTime: 120_000, trigger: 'scheduled' })
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

  it('rolls back in-memory claim state when the log append fails, so a retry is not a phantom duplicate', async () => {
    const store = new FileExecutionStore(dir)
    const first = await store.claim({ taskId: 't1', scheduledFireTime: 60_000, trigger: 'scheduled' })
    expect(first.kind).toBe('claimed')

    // Break the source-of-truth log: replacing the file with a directory makes
    // appendFile fail (EISDIR) for the next commit.
    const logPath = path.join(dir, 'executions.jsonl')
    await rm(logPath)
    await mkdir(logPath)

    await expect(
      store.claim({ taskId: 't2', scheduledFireTime: 60_000, trigger: 'scheduled' }),
    ).rejects.toThrow()

    // The failed claim must leave NO phantom state: once the log is writable
    // again, the identical claim must succeed — not report `duplicate` — and
    // the failed task must not linger as an active/skip blocker.
    await rm(logPath, { recursive: true })
    const retried = await store.claim({ taskId: 't2', scheduledFireTime: 60_000, trigger: 'scheduled' })
    expect(retried.kind).toBe('claimed')
    expect((await store.list()).filter((e) => e.cronTaskId === 't2')).toHaveLength(1)
  })

  it('a failed execution-index.json write does not fail a durable claim and is reported via diagnostics', async () => {
    // Break the rebuildable observability index: a directory at the target
    // path makes atomicWriteJson's rename fail.
    await mkdir(path.join(dir, 'execution-index.json'))

    const onDiagnostic = vi.fn()
    const store = new FileExecutionStore(dir, { onDiagnostic })

    // The source-of-truth log append succeeds, so the claim IS durable: it
    // must report success and the execution must remain fully usable.
    const result = await store.claim({ taskId: 't1', scheduledFireTime: 60_000, trigger: 'scheduled' })
    expect(result.kind).toBe('claimed')
    expect(result.execution.status).toBe('pending')

    const done = await store.updateStatus(result.execution.id, 'succeeded', { output: 'ok' })
    expect(done).toMatchObject({ status: 'succeeded', output: 'ok' })

    const messages = onDiagnostic.mock.calls.map((c) => String(c[0]))
    expect(messages.some((m) => /execution-index\.json/.test(m))).toBe(true)
  })
})

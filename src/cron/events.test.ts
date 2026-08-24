import { describe, expect, it, vi } from 'vitest'

import { emitCronEvent, noopEventSink, reportCronDiagnostic } from './events.js'
import type { CronExecution, CronTask } from './types.js'

const task: CronTask = {
  id: 't1',
  cron: '* * * * *',
  prompt: 'p',
  createdAt: 1,
}

const execution: CronExecution = {
  id: 'e1',
  cronTaskId: 't1',
  scheduledFireTime: 60_000,
  trigger: 'scheduled',
  status: 'succeeded',
}

describe('emitCronEvent', () => {
  it('forwards the event to the sink', async () => {
    const sink = vi.fn()
    await emitCronEvent(sink, { type: 'taskCreated', task })
    expect(sink).toHaveBeenCalledWith({ type: 'taskCreated', task })
  })

  it('never rejects when the sink throws', async () => {
    const sink = vi.fn(() => { throw new Error('sink down') })
    await expect(
      emitCronEvent(sink, { type: 'executionCompleted', execution }),
    ).resolves.toBeUndefined()
  })

  it('supports async sinks', async () => {
    const sink = vi.fn(async () => {})
    await emitCronEvent(sink, { type: 'taskDeleted', taskId: 't1' })
    expect(sink).toHaveBeenCalledOnce()
  })

  it('is a no-op when sink is undefined', async () => {
    await expect(emitCronEvent(undefined, { type: 'taskDeleted', taskId: 't1' })).resolves.toBeUndefined()
  })

  it('reports sink failures via onDiagnostic without rejecting', async () => {
    const sink = vi.fn(() => { throw new Error('sink down') })
    const onDiagnostic = vi.fn()
    await expect(
      emitCronEvent(sink, { type: 'executionCompleted', execution }, onDiagnostic),
    ).resolves.toBeUndefined()
    expect(onDiagnostic).toHaveBeenCalledOnce()
    expect(onDiagnostic.mock.calls[0]![0]).toMatch(/sink down/)
  })

  it('reports async sink failures via onDiagnostic', async () => {
    const sink = vi.fn(async () => { throw new Error('async sink down') })
    const onDiagnostic = vi.fn()
    await expect(
      emitCronEvent(sink, { type: 'taskDeleted', taskId: 't1' }, onDiagnostic),
    ).resolves.toBeUndefined()
    expect(onDiagnostic).toHaveBeenCalledWith(expect.stringMatching(/async sink down/))
  })

  it('does not call onDiagnostic when the sink succeeds', async () => {
    const onDiagnostic = vi.fn()
    await emitCronEvent(noopEventSink, { type: 'taskCreated', task }, onDiagnostic)
    expect(onDiagnostic).not.toHaveBeenCalled()
  })

  it('never rejects when the diagnostics sink itself throws', async () => {
    const sink = vi.fn(() => { throw new Error('sink down') })
    const onDiagnostic = vi.fn(() => { throw new Error('diagnostics down') })
    await expect(
      emitCronEvent(sink, { type: 'executionCompleted', execution }, onDiagnostic),
    ).resolves.toBeUndefined()
  })

  it('reportCronDiagnostic delivers best-effort and never throws', () => {
    const onDiagnostic = vi.fn()
    reportCronDiagnostic(onDiagnostic, 'all good')
    expect(onDiagnostic).toHaveBeenCalledWith('all good')
    // A broken sink must not propagate.
    expect(() =>
      reportCronDiagnostic(() => { throw new Error('diagnostics down') }, 'm'),
    ).not.toThrow()
    // No sink configured: still a no-op, never a throw.
    expect(() => reportCronDiagnostic(undefined, 'm')).not.toThrow()
  })

  it('noopEventSink accepts any event', () => {
    expect(() => noopEventSink({ type: 'taskDeleted', taskId: 't1' })).not.toThrow()
  })
})

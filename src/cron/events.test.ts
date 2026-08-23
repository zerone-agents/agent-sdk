import { describe, expect, it, vi } from 'vitest'

import { emitCronEvent, noopEventSink } from './events.js'
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

  it('noopEventSink accepts any event', () => {
    expect(() => noopEventSink({ type: 'taskDeleted', taskId: 't1' })).not.toThrow()
  })
})

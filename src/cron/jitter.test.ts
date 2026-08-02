import { describe, expect, it } from 'vitest'

import {
  jitteredNextCronRunMs,
  jitterFrac,
} from './jitter.js'

function localTimeMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second = 0,
): number {
  return new Date(year, month - 1, day, hour, minute, second).getTime()
}

describe('jitterFrac', () => {
  it('returns values in the [0, 1) range', () => {
    expect(jitterFrac('00000000-task')).toBeGreaterThanOrEqual(0)
    expect(jitterFrac('00000000-task')).toBeLessThan(1)
    expect(jitterFrac('ffffffff-task')).toBeGreaterThanOrEqual(0)
    expect(jitterFrac('ffffffff-task')).toBeLessThan(1)
  })

  it('is deterministic for the same taskId', () => {
    const first = jitterFrac('89abcdef-task')
    const second = jitterFrac('89abcdef-task')

    expect(second).toBe(first)
  })

  it('returns different values for different taskIds', () => {
    expect(jitterFrac('00000000-task')).not.toBe(jitterFrac('80000000-task'))
  })
})

describe('jitteredNextCronRunMs', () => {
  it('returns a timestamp greater than or equal to fromMs', () => {
    const fromMs = localTimeMs(2026, 1, 1, 0, 0)
    const next = jitteredNextCronRunMs('*/5 * * * *', fromMs, '80000000-task')

    expect(next).not.toBeNull()
    expect(next!).toBeGreaterThanOrEqual(fromMs)
  })

  it('is deterministic for the same inputs', () => {
    const fromMs = localTimeMs(2026, 1, 1, 0, 0)
    const first = jitteredNextCronRunMs('*/5 * * * *', fromMs, '80000000-task')
    const second = jitteredNextCronRunMs('*/5 * * * *', fromMs, '80000000-task')

    expect(second).toBe(first)
  })

  it('returns null for invalid cron expressions', () => {
    expect(jitteredNextCronRunMs('invalid cron', Date.now(), 'task-1')).toBeNull()
  })
})

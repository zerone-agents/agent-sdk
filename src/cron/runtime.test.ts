import { describe, expect, it, vi } from 'vitest'

import { CronRuntime } from './runtime.js'

function makeParts() {
  const scheduler = {
    start: vi.fn(async () => {}),
    stop: vi.fn(),
    suspend: vi.fn(),
    resume: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    snapshot: vi.fn(() => []),
  }
  const coordinator = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    suspend: vi.fn(async () => {}),
    submit: vi.fn(),
    idle: vi.fn(async () => {}),
  }
  const runtime = new CronRuntime({
    scheduler: scheduler as never,
    coordinator: coordinator as never,
  })
  return { scheduler, coordinator, runtime }
}

describe('CronRuntime', () => {
  it('starts coordinator before scheduler and reaches running', async () => {
    const { scheduler, coordinator, runtime } = makeParts()
    const order: string[] = []
    coordinator.start.mockImplementation(async () => { order.push('coordinator') })
    scheduler.start.mockImplementation(async () => { order.push('scheduler') })

    await runtime.start()

    expect(order).toEqual(['coordinator', 'scheduler'])
    expect(runtime.getState()).toBe('running')
  })

  it('stop() stops the scheduler before draining the coordinator', async () => {
    const { scheduler, coordinator, runtime } = makeParts()
    const order: string[] = []
    scheduler.stop.mockImplementation(() => { order.push('scheduler') })
    coordinator.stop.mockImplementation(async () => { order.push('coordinator') })
    await runtime.start()

    await runtime.stop({ drainMs: 10 })

    expect(order).toEqual(['scheduler', 'coordinator'])
    expect(coordinator.stop).toHaveBeenCalledWith({ drainMs: 10 })
    expect(runtime.getState()).toBe('stopped')
  })

  it('suspend/resume transitions running -> suspended -> running', async () => {
    const { runtime } = makeParts()
    await runtime.start()

    await runtime.suspend()
    expect(runtime.getState()).toBe('suspended')
    expect((await runtime.resume(), runtime.getState())).toBe('running')
  })

  it('ignores lifecycle calls in wrong states', async () => {
    const { scheduler, coordinator, runtime } = makeParts()
    await runtime.stop() // stopped: no-op
    await runtime.suspend() // stopped: no-op
    await runtime.resume() // stopped: no-op
    expect(scheduler.stop).not.toHaveBeenCalled()

    await runtime.start()
    await runtime.start() // running: no-op
    expect(scheduler.start).toHaveBeenCalledTimes(1)
    await runtime.suspend()
    await runtime.suspend() // suspended: no-op
    expect(scheduler.suspend).toHaveBeenCalledTimes(1)
    await coordinator.stop.mockImplementation(async () => {})
    await runtime.resume()
    await runtime.resume() // running: no-op
    expect(scheduler.resume).toHaveBeenCalledTimes(1)
  })
})

import { describe, expect, it } from 'vitest'

import { FakeClock, ManualTimer, systemClock, systemTimer, waitViaTimer } from './clock.js'

describe('FakeClock', () => {
  it('returns the set time', () => {
    const clock = new FakeClock(1_000)
    expect(clock.now()).toBe(1_000)
    clock.set(5_000)
    expect(clock.now()).toBe(5_000)
  })
})

describe('ManualTimer', () => {
  it('fires callbacks in deadline order and awaits async callbacks', async () => {
    const clock = new FakeClock(0)
    const timer = new ManualTimer(clock)
    const fired: string[] = []
    timer.setTimeout(() => { fired.push('a') }, 100)
    timer.setTimeout(async () => {
      await Promise.resolve()
      fired.push('b')
    }, 50)

    await timer.advance(100)

    expect(fired).toEqual(['b', 'a'])
    expect(clock.now()).toBe(100)
    expect(timer.pendingCount()).toBe(0)
  })

  it('clearTimeout cancels a pending callback', async () => {
    const clock = new FakeClock(0)
    const timer = new ManualTimer(clock)
    let fired = false
    const handle = timer.setTimeout(() => { fired = true }, 10)
    timer.clearTimeout(handle)

    await timer.advance(20)

    expect(fired).toBe(false)
  })

  it('runs callbacks scheduled during advance in the same pass', async () => {
    const clock = new FakeClock(0)
    const timer = new ManualTimer(clock)
    const order: number[] = []
    timer.setTimeout(() => {
      order.push(1)
      timer.setTimeout(() => { order.push(2) }, 5)
    }, 10)

    await timer.advance(20)

    expect(order).toEqual([1, 2])
  })
})

describe('waitViaTimer', () => {
  it('resolves after the timer fires', async () => {
    const clock = new FakeClock(0)
    const timer = new ManualTimer(clock)
    const p = waitViaTimer(timer, 30)
    await timer.advance(30)
    await expect(p).resolves.toBeUndefined()
  })
})

describe('system adapters', () => {
  it('systemTimer clears real timeouts', async () => {
    const handle = systemTimer.setTimeout(() => { throw new Error('must not fire') }, 10)
    systemTimer.clearTimeout(handle)
    await new Promise((resolve) => setTimeout(resolve, 20))
  })

  it('systemClock returns a positive timestamp', () => {
    expect(systemClock.now()).toBeGreaterThan(0)
  })
})

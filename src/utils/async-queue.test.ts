import { describe, expect, it } from 'vitest'
import { AsyncQueue } from './async-queue.js'

describe('AsyncQueue', () => {
  it('returns pushed items synchronously via next()', async () => {
    const q = new AsyncQueue<number>()
    q.push(1)
    q.push(2)
    q.push(3)
    expect((await q.next()).value).toBe(1)
    expect((await q.next()).value).toBe(2)
    expect((await q.next()).value).toBe(3)
  })

  it('resolves pending next() when push() arrives', async () => {
    const q = new AsyncQueue<string>()
    const p = q.next()
    q.push('hello')
    expect((await p).value).toBe('hello')
  })

  it('returns { done: true } after close() when queue is empty', async () => {
    const q = new AsyncQueue<number>()
    q.close()
    const result = await q.next()
    expect(result.done).toBe(true)
  })

  it('resolves pending next() with done when close() is called', async () => {
    const q = new AsyncQueue<number>()
    const p = q.next()
    q.close()
    expect((await p).done).toBe(true)
  })

  it('push() after close() is a no-op', async () => {
    const q = new AsyncQueue<number>()
    q.push(1)
    q.close()
    q.push(2) // no-op
    expect((await q.next()).value).toBe(1)
    expect((await q.next()).done).toBe(true)
  })

  it('preserves FIFO order for multiple pushes before consumes', async () => {
    const q = new AsyncQueue<string>()
    q.push('a')
    q.push('b')
    q.push('c')
    q.close()
    const got: string[] = []
    while (true) {
      const item = await q.next()
      if (item.done) break
      got.push(item.value)
    }
    expect(got).toEqual(['a', 'b', 'c'])
  })

  it('works as an async iterator via for-await', async () => {
    const q = new AsyncQueue<number>()
    q.push(10)
    q.push(20)
    q.close()
    const got: number[] = []
    for await (const x of q) {
      got.push(x)
    }
    expect(got).toEqual([10, 20])
  })

  it('drains items pushed before close, then terminates', async () => {
    const q = new AsyncQueue<number>()
    q.push(1)
    q.push(2)
    q.close()
    // Even though closed, items already in queue should be returned
    expect((await q.next()).value).toBe(1)
    expect((await q.next()).value).toBe(2)
    expect((await q.next()).done).toBe(true)
  })
})

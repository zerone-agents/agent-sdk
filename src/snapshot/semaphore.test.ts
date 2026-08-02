import { describe, it, expect } from 'vitest'
import { Semaphore, getLock, LockTimeoutError } from './semaphore.js'

describe('Semaphore', () => {
  it('serializes concurrent operations', async () => {
    const sem = new Semaphore()
    const order: string[] = []
    await sem.acquire()
    const p = sem.acquire().then(() => { order.push('second') })
    order.push('first')
    sem.release()
    await p
    sem.release()
    expect(order).toEqual(['first', 'second'])
  })

  it('allows reuse after release', async () => {
    const sem = new Semaphore()
    await sem.acquire()
    sem.release()
    await sem.acquire()
    sem.release()
  })

  it('rejects with LockTimeoutError when acquire times out', async () => {
    const sem = new Semaphore()
    await sem.acquire()  // held
    await expect(sem.acquire(50)).rejects.toBeInstanceOf(LockTimeoutError)
    // cleanup
    sem.release()
  })

  it('does not call release on behalf of timed-out acquirer', async () => {
    const sem = new Semaphore()
    await sem.acquire()  // 持有者 A
    // B 排队并超时
    await expect(sem.acquire(20)).rejects.toBeInstanceOf(LockTimeoutError)
    // 此时仍只有 A 持有锁，release 一次应让队列清空
    const p = sem.acquire()
    sem.release()  // A 释放
    await p
    sem.release()
  })

  it('accepts undefined timeoutMs for backward compatibility (waits indefinitely)', async () => {
    const sem = new Semaphore()
    await sem.acquire()
    // 用一个立即 release 的延迟测试不超时
    setTimeout(() => sem.release(), 10)
    await expect(sem.acquire()).resolves.toBeUndefined()
  })

  it('getLock returns same instance for same key', () => {
    const a = getLock('/tmp/x')
    const b = getLock('/tmp/x')
    const c = getLock('/tmp/y')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })
})

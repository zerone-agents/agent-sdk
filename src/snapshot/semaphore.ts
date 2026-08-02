/**
 * Simple promise-based serial lock.
 * Ensures git operations on the same repo are serialized.
 */
export class LockTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Semaphore.acquire timed out after ${timeoutMs}ms`)
    this.name = 'LockTimeoutError'
  }
}

export class Semaphore {
  private queue: Array<{ resolve: () => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> }> = []
  private locked = false

  async acquire(timeoutMs?: number): Promise<void> {
    if (!this.locked) {
      this.locked = true
      return
    }

    return new Promise<void>((resolve, reject) => {
      let entry: { resolve: () => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> }
      entry = {
        resolve: () => {
          if (entry.timer) clearTimeout(entry.timer)
          resolve()
        },
        reject,
        timer: timeoutMs !== undefined
          ? setTimeout(() => {
              // 从队列中移除自己
              const idx = this.queue.indexOf(entry)
              if (idx >= 0) this.queue.splice(idx, 1)
              reject(new LockTimeoutError(timeoutMs))
            }, timeoutMs)
          : undefined,
      }
      this.queue.push(entry)
    })
  }

  release(): void {
    const next = this.queue.shift()
    if (next) {
      next.resolve()
      // next 已 resolved，锁仍由新持有者掌握
    } else {
      this.locked = false
    }
  }
}

/**
 * Module-level lock registry — ensures only one Semaphore per gitDir
 * across multiple SnapshotEngine instances in the same process.
 */
const lockRegistry = new Map<string, Semaphore>()

export function getLock(key: string): Semaphore {
  let lock = lockRegistry.get(key)
  if (!lock) {
    lock = new Semaphore()
    lockRegistry.set(key, lock)
  }
  return lock
}

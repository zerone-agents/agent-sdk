/**
 * Single-producer / single-consumer async queue.
 *
 * The producer pushes items via `push()` and signals completion via `close()`.
 * The consumer pulls items via `next()` or `for await (...)`.
 *
 * Used by the engine to bridge concurrent tool execution (multiple promises
 * pushing events) into a single ordered async iterator consumed by the main
 * generator loop.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = []
  private pending: ((value: IteratorResult<T>) => void) | null = null
  private closed = false

  push(item: T): void {
    if (this.closed) return
    if (this.pending) {
      const resolve = this.pending
      this.pending = null
      resolve({ value: item, done: false })
    } else {
      this.items.push(item)
    }
  }

  close(): void {
    this.closed = true
    if (this.pending) {
      const resolve = this.pending
      this.pending = null
      resolve({ value: undefined, done: true })
    }
  }

  next(): Promise<IteratorResult<T>> {
    if (this.items.length > 0) {
      return Promise.resolve({ value: this.items.shift()!, done: false })
    }
    if (this.closed) {
      return Promise.resolve({ value: undefined as any, done: true })
    }
    return new Promise((resolve) => {
      this.pending = resolve
    })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this
  }
}

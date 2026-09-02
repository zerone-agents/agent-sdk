import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { acquireRuntimeLock } from './lock.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cron-sdk-lock-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('acquireRuntimeLock', () => {
  it('creates runtime.lock and releases cleanly', async () => {
    const lock = await acquireRuntimeLock(dir)
    await lock.release()
    // re-acquire works after release
    const again = await acquireRuntimeLock(dir)
    await again.release()
  })

  it('creates the directory when missing', async () => {
    const nested = path.join(dir, 'cron')
    const lock = await acquireRuntimeLock(nested)
    await lock.release()
  })

  it('fails with a clear error when another runtime holds the lock', async () => {
    const first = await acquireRuntimeLock(dir)

    await expect(acquireRuntimeLock(dir)).rejects.toThrow(
      /Cron runtime already running for directory: .*runtime\.lock/,
    )

    await first.release()
  })

  it('release is idempotent', async () => {
    const lock = await acquireRuntimeLock(dir)
    await lock.release()
    await expect(lock.release()).resolves.toBeUndefined()
  })

  it("a repeated release never removes a NEW owner's lock", async () => {
    const first = await acquireRuntimeLock(dir)
    await first.release()
    const second = await acquireRuntimeLock(dir)

    // The stale owner's repeated release must be a no-op, not an unlink of
    // the live lock — otherwise a third owner could enter while the second
    // still holds it (mutual exclusion broken).
    await first.release()
    await expect(acquireRuntimeLock(dir)).rejects.toThrow(/already running/)

    await second.release()
    // And the released directory is free again.
    const third = await acquireRuntimeLock(dir)
    await third.release()
  })
})

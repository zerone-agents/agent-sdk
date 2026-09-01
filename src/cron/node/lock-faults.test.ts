import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * Fault injection for the shared runtime-lock helper (issue #52 review):
 * the lock-failure boundaries must be exception-safe (no wedged lock file
 * on partial acquisition) and observable (release failures surface).
 * Happy paths live in lock.test.ts against the real filesystem.
 */

const faults = vi.hoisted(() => ({
  write: null as Error | null,
  unlink: null as Error | null,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...real,
    open: (async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args)
      // Delegate to the ORIGINAL handle instance (FileHandle methods do not
      // survive detachment); only intercept write for fault injection.
      return {
        write: async (...writeArgs: Parameters<typeof handle.write>) => {
          if (faults.write) throw faults.write
          return handle.write(...writeArgs)
        },
        close: () => handle.close(),
      } as unknown as FileHandle
    }) as typeof real.open,
    unlink: (async (...args: Parameters<typeof real.unlink>) => {
      if (faults.unlink) throw faults.unlink
      return real.unlink(...args)
    }) as typeof real.unlink,
  }
})

import { acquireRuntimeLock } from './lock.js'

let dir: string

beforeEach(async () => {
  faults.write = null
  faults.unlink = null
  dir = await mkdtemp(path.join(tmpdir(), 'cron-sdk-lock-fault-'))
})

afterEach(async () => {
  faults.write = null
  faults.unlink = null
  await rm(dir, { recursive: true, force: true })
})

describe('acquireRuntimeLock fault boundaries (issue #52 review)', () => {
  it('release surfaces non-ENOENT unlink failures instead of resolving', async () => {
    const lock = await acquireRuntimeLock(dir)
    const lockPath = path.join(dir, 'runtime.lock')
    faults.unlink = Object.assign(new Error('EACCES: permission denied, unlink'), {
      code: 'EACCES',
    })

    await expect(lock.release()).rejects.toMatchObject({ code: 'EACCES' })
    // The lock file still exists — exactly why the failure must be
    // observable: every subsequent owner is blocked until cleanup.
    await expect(stat(lockPath)).resolves.toBeTruthy()

    // After the fault clears, release succeeds (file removed) — idempotent.
    faults.unlink = null
    await lock.release()
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('release still treats ENOENT as idempotent success', async () => {
    const lock = await acquireRuntimeLock(dir)
    await lock.release()
    faults.unlink = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
    await expect(lock.release()).resolves.toBeUndefined()
  })

  it('a failed metadata write cleans the lock file up and surfaces the original error', async () => {
    faults.write = Object.assign(new Error('ENOSPC: no space left on device'), {
      code: 'ENOSPC',
    })

    await expect(acquireRuntimeLock(dir)).rejects.toMatchObject({ code: 'ENOSPC' })
    // Acquisition is exception-safe: no leftover runtime.lock wedging the dir.
    await expect(stat(path.join(dir, 'runtime.lock'))).rejects.toMatchObject({ code: 'ENOENT' })

    // The directory is NOT wedged: after the fault clears, the next
    // acquisition succeeds.
    faults.write = null
    const lock = await acquireRuntimeLock(dir)
    await lock.release()
  })

  it('a cleanup failure during acquisition does not mask the original error', async () => {
    faults.write = Object.assign(new Error('ENOSPC: no space left on device'), {
      code: 'ENOSPC',
    })
    faults.unlink = Object.assign(new Error('EACCES: permission denied, unlink'), {
      code: 'EACCES',
    })

    // The cleanup unlink failing (EACCES) must not replace the original
    // write failure (ENOSPC) in the rejection.
    await expect(acquireRuntimeLock(dir)).rejects.toMatchObject({ code: 'ENOSPC' })
  })
})

import { mkdir, open, unlink } from 'node:fs/promises'
import path from 'node:path'

import type { CronRuntimeLock } from '../service.js'

/**
 * Single-writer directory lock: `<cronDir>/runtime.lock` created with O_EXCL.
 * A crash leaves the file behind — the startup error names the path for
 * manual cleanup (stale-lock liveness detection is a documented non-goal
 * of issue #42 v1).
 */
export async function acquireRuntimeLock(cronDir: string): Promise<CronRuntimeLock> {
  await mkdir(cronDir, { recursive: true })
  const lockPath = path.join(cronDir, 'runtime.lock')

  let handle: import('node:fs/promises').FileHandle
  try {
    handle = await open(lockPath, 'wx')
  } catch {
    throw new Error(`Cron runtime already running for directory: ${lockPath}`)
  }
  try {
    await handle.write(
      `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`,
    )
    await handle.close()
  } catch (err) {
    // Exception-safe acquisition (issue #52 review): a failure at ANY point
    // after the O_EXCL create — write OR close — must not leave the lock
    // file behind; the directory would stay wedged for every future owner
    // until manual cleanup. Best-effort cleanup, then surface the ORIGINAL
    // failure (a secondary cleanup error must not mask it).
    await handle.close().catch(() => {})
    await unlink(lockPath).catch(() => {})
    throw err
  }

  // Ownership token (issue #52 review): at most ONE unlink of lockPath may
  // ever issue from this handle. A repeated or concurrent release() on an
  // already-released owner is a no-op — it must never unlink a NEW owner's
  // lock (the old owner's double release deleting the new owner's file would
  // silently break mutual exclusion).
  let held = true

  return {
    // The lock is already held when returned; acquire() is an idempotent no-op
    // so the object satisfies the CronRuntimeLock port consumed by start().
    acquire: async () => {},
    release: async () => {
      if (!held) return
      // Claim the release synchronously BEFORE unlink: a concurrent second
      // release observes held === false and never touches the file.
      held = false
      await unlink(lockPath).catch((err) => {
        // ENOENT = already gone. Any other failure (EACCES, EPERM, EBUSY, ...)
        // must surface: resolving while runtime.lock still exists would
        // silently wedge the directory for every subsequent Runtime/
        // maintenance owner. Restore ownership so the caller can retry the
        // failed release.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          held = true
          throw err
        }
      })
    },
  }
}

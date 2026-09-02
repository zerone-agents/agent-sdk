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
    // until manual cleanup. A cleanup failure is surfaced TOGETHER with the
    // original error: the caller must learn the partial lock file may still
    // exist (round-3 review).
    await handle.close().catch(() => {})
    const cleanupFailure = await unlink(lockPath).then(
      () => null,
      (cleanupErr: unknown) => cleanupErr,
    )
    if (cleanupFailure !== null) {
      const original = err instanceof Error ? err.message : String(err)
      const cleanupMessage =
        cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure)
      throw new Error(
        `Failed to acquire cron lock at ${lockPath}: ${original} — and removing the ` +
          `partial lock file also failed (${cleanupMessage}); delete it manually.`,
      )
    }
    throw err
  }

  // Shared-outcome release (issue #52 review round 3): the FIRST release()
  // owns the single unlink of lockPath; every concurrent or later call
  // observes the SAME promise — a failed unlink rejects for ALL callers (no
  // silent "success" while the lock file remains), and a settled release is
  // an idempotent no-op that can never unlink a NEW owner's lock. On failure
  // the token resets so a retry issues a fresh unlink.
  let releasePromise: Promise<void> | null = null

  return {
    // The lock is already held when returned; acquire() is an idempotent no-op
    // so the object satisfies the CronRuntimeLock port consumed by start().
    acquire: async () => {},
    release: () => {
      if (releasePromise !== null) return releasePromise
      releasePromise = unlink(lockPath).catch((err) => {
        // ENOENT = already gone (idempotent). Any other failure (EACCES,
        // EPERM, EBUSY, ...) must surface for EVERY caller: resolving while
        // runtime.lock still exists would silently wedge the directory for
        // every subsequent Runtime/maintenance owner.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          releasePromise = null
          throw err
        }
      })
      return releasePromise
    },
  }
}

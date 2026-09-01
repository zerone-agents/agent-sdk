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
  } catch (err) {
    // Exception-safe acquisition (issue #52 review): a failure after the
    // O_EXCL create but before returning must not leave the lock file
    // behind — the directory would stay wedged for every future owner
    // until manual cleanup. Best-effort cleanup, then surface the ORIGINAL
    // failure (a secondary cleanup error must not mask it).
    await handle.close().catch(() => {})
    await unlink(lockPath).catch(() => {})
    throw err
  }
  await handle.close()

  return {
    // The lock is already held when returned; acquire() is an idempotent no-op
    // so the object satisfies the CronRuntimeLock port consumed by start().
    acquire: async () => {},
    release: async () => {
      await unlink(lockPath).catch((err) => {
        // ENOENT = already released (idempotent). Any other failure (EACCES,
        // EPERM, EBUSY, ...) must surface: resolving while runtime.lock still
        // exists would silently wedge the directory for every subsequent
        // Runtime/maintenance owner (issue #52 review).
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      })
    },
  }
}

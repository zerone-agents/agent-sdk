// src/memory/node/lock.ts
import { mkdir, open, unlink } from 'node:fs/promises'
import path from 'node:path'
import { MemoryStorageLockError } from '../errors.js'

export interface MemoryLock {
  release(): Promise<void>
}

export async function acquireMemoryLock(memoryDir: string): Promise<MemoryLock> {
  await mkdir(memoryDir, { recursive: true, mode: 0o700 })
  const lockPath = path.join(memoryDir, 'runtime.lock')

  let handle: import('node:fs/promises').FileHandle
  try {
    handle = await open(lockPath, 'wx')
  } catch (err) {
    // FAIL-CLOSED (static review P1-1): NO stale-lock reclamation. Reclamation
    // is check-then-act and two processes that both deem the old owner dead
    // will unlink each other's fresh locks → double writers. EEXIST always
    // rejects; the lock file keeps {pid, acquiredAt} for host diagnosis and
    // manual cleanup (cron's lock takes the same stance, issue #42 v1).
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new MemoryStorageLockError(
        lockPath,
        'stale locks are not reclaimed automatically — verify the recorded owner process is gone, then delete the lock file manually',
      )
    }
    throw err
  }
  try {
    await handle.write(
      `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`,
    )
    await handle.close()
  } catch (err) {
    // Exception-safe acquisition (mirror src/cron/node/lock.ts): a failure at
    // ANY point after the O_EXCL create — write OR close — must not leave the
    // lock file behind; a cleanup failure is surfaced TOGETHER with the
    // original error so the caller learns the lock may still exist.
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
        `Failed to acquire memory lock at ${lockPath}: ${original} — and removing the ` +
          `partial lock file also failed (${cleanupMessage}); delete it manually.`,
      )
    }
    throw err
  }

  // Shared-outcome release (mirror cron): FIRST release() owns the single
  // unlink; every concurrent/later call observes the SAME promise — a failed
  // unlink rejects for ALL callers, and a settled release is an idempotent
  // no-op that can never unlink a NEW owner's lock.
  let releasePromise: Promise<void> | null = null

  return {
    release: () => {
      if (releasePromise !== null) return releasePromise
      releasePromise = unlink(lockPath).catch((err) => {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          releasePromise = null
          throw err
        }
      })
      return releasePromise
    },
  }
}
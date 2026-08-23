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
  } finally {
    await handle.close()
  }

  return {
    // The lock is already held when returned; acquire() is an idempotent no-op
    // so the object satisfies the CronRuntimeLock port consumed by start().
    acquire: async () => {},
    release: async () => {
      await unlink(lockPath).catch(() => {})
    },
  }
}

import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

let cached: boolean | null = null

/**
 * Detect if git CLI is available. Result is cached.
 */
export async function isGitAvailable(): Promise<boolean> {
  if (cached !== null) return cached
  try {
    await execFileAsync('git', ['--version'])
    cached = true
  } catch {
    cached = false
  }
  return cached
}

/**
 * Reset the cache (for testing).
 */
export function resetGitCache(): void {
  cached = null
}

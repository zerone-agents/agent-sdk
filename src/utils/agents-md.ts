import { readFile, stat } from 'fs/promises'
import { join, dirname } from 'path'
import { homedir } from 'os'
import type { SettingSource } from '../types.js'

/** Maximum size of a single AGENTS.md file. Files exceeding this are skipped with an [ERROR] marker. */
export const MAX_AGENTS_MD_BYTES = 32 * 1024

/** @internal */
export type Level = 'user' | 'project'

/** @internal */
export interface LoadedFile {
  path: string
  content: string | null
  error: string | null
}

/** @internal */
export async function readWithLimit(
  path: string,
  limit: number,
): Promise<LoadedFile | null> {
  let size: number
  try {
    const s = await stat(path)
    size = s.size
  } catch {
    return null // file missing — normal case, not an error
  }
  if (size > limit) {
    const kib = (limit / 1024).toFixed(0)
    return {
      path,
      content: null,
      error: `File exceeds ${kib} KiB limit (actual: ${size} bytes) and was skipped.`,
    }
  }
  const content = await readFile(path, 'utf-8')
  return { path, content, error: null }
}

/**
 * Walks up from `cwd` until a `.git` entry (file or directory) is found and
 * returns that directory. If filesystem root is reached without finding one,
 * returns `cwd` as a fallback.
 *
 * Uses `stat` (follows symlinks, accepts both files and dirs), so a worktree's
 * `.git` file is detected the same way as a regular repo's `.git` directory.
 *
 * @internal
 */
export async function findProjectRoot(cwd: string): Promise<string> {
  let dir = cwd
  for (;;) {
    try {
      await stat(join(dir, '.git'))
      return dir
    } catch {
      // no .git here — keep walking up
    }
    const parent = dirname(dir)
    if (parent === dir) return cwd // reached filesystem root
    dir = parent
  }
}

/**
 * Enumerates the candidate `AGENTS.md` paths from `root` down to `cwd`
 * (inclusive of both), ordered least-specific first.
 *
 * Pure and synchronous: does not stat the filesystem. The caller is expected
 * to filter via `readWithLimit` (which returns `null` for missing files).
 *
 * Assumes `root` is `cwd` or an ancestor of `cwd` — no validation is performed.
 *
 * @internal
 */
export function collectProjectPaths(root: string, cwd: string): string[] {
  const paths: string[] = []
  let dir = cwd
  for (;;) {
    paths.unshift(join(dir, 'AGENTS.md'))
    if (dir === root) break
    dir = dirname(dir)
  }
  return paths
}

/**
 * Renders a `LoadedFile` into a `## <level>-level Instructions (<path>)` header
 * followed by `\n\n` and the body. On error, the body is `[ERROR] <message>`
 * (the file content is dropped). Pure synchronous.
 *
 * @internal
 */
export function render(file: LoadedFile, level: Level): string {
  const label = level === 'user' ? 'User-level' : 'Project-level'
  const header = `## ${label} Instructions (${file.path})`
  if (file.error) return `${header}\n\n[ERROR] ${file.error}`
  return `${header}\n\n${file.content}`
}

export async function loadAgentsMd(
  cwd: string,
  settingSources?: SettingSource[]
): Promise<string | null> {
  if (!settingSources || settingSources.length === 0) {
    return null
  }

  const parts: string[] = []

  if (settingSources.includes('user')) {
    const userPath = join(homedir(), '.agents', 'AGENTS.md')
    const content = await safeReadFile(userPath)
    if (content) {
      parts.push(`## User-level Instructions\n${content}`)
    }
  }

  if (settingSources.includes('project')) {
    const projectHiddenPath = join(cwd, '.agents', 'AGENTS.md')
    const projectPath = join(cwd, 'AGENTS.md')

    const content = await safeReadFile(projectHiddenPath) || await safeReadFile(projectPath)
    if (content) {
      parts.push(`## Project-level Instructions\n${content}`)
    }
  }

  return parts.length > 0 ? parts.join('\n\n') : null
}

async function safeReadFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return null
  }
}
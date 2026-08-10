import { readFile } from 'fs/promises'
import { join } from 'path'
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
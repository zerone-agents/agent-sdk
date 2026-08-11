/**
 * System Context
 *
 * Builds the <environment> block for the system prompt:
 * - Model identity
 * - Working directory
 * - Git repo status
 * - Platform
 * - Current date
 *
 * Project instructions (AGENTS.md) are handled separately by agents-md.ts.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

/**
 * Check whether a directory is inside a git repository.
 */
async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rev-parse', '--git-dir'], {
      cwd,
      timeout: 3000,
    })
    return true
  } catch {
    return false
  }
}

/**
 * Get system context for the system prompt.
 *
 * Outputs an <environment> XML block containing the model identity line,
 * a brief preamble, and the environment fields — mirroring OpenCode's
 * environment injection format.
 *
 * Example output:
 *
 *   <environment>
 *   You are powered by the model named claude-sonnet-4-6.
 *   Here is some useful information about the environment you are running in:
 *   Working directory: /Users/zero/project
 *   Is directory a git repo: yes
 *   Platform: darwin
 *   Today's date: Sun Apr 13 2026
 *   </environment>
 */
export async function getSystemContext(cwd: string, model?: string): Promise<string> {
  const lines: string[] = []

  lines.push('<environment>')
  if (model) {
    lines.push(`You are powered by the model named ${model}.`)
  }
  lines.push('Here is some useful information about the environment you are running in:')
  lines.push(`Working directory: ${cwd}`)
  lines.push(`Is directory a git repo: ${await isGitRepo(cwd) ? 'yes' : 'no'}`)
  lines.push(`Platform: ${process.platform}`)
  lines.push(`Today's date: ${new Date().toDateString()}`)
  lines.push('</environment>')

  return lines.join('\n')
}

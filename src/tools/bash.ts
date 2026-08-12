/**
 * BashTool - Execute shell commands
 * Supports macOS (zsh > bash), Linux (bash), Windows (PowerShell > Git Bash > cmd)
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import crossSpawn from 'cross-spawn'
import { defineTool } from './types.js'

const MAX_OUTPUT_CHARS = 100_000
const MAX_LINES = 2000
const MAX_BYTES = 51_200

/**
 * Model-facing timeout contract (issue #27): seconds, not milliseconds.
 * Seconds match common CLI conventions (`curl --max-time`, `timeout(1)`),
 * which dramatically reduces unit-confusion when the model fills the field.
 */
const DEFAULT_TIMEOUT_SECONDS = 120
const MIN_TIMEOUT_SECONDS = 1
const MAX_TIMEOUT_SECONDS = 600

/**
 * Clamp a user-supplied timeout (seconds) into the supported range and
 * convert to milliseconds for internal use. Exported for tests.
 */
export function resolveTimeoutMs(userTimeoutSeconds: number | undefined): number {
  const seconds = Math.min(
    Math.max(userTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS, MIN_TIMEOUT_SECONDS),
    MAX_TIMEOUT_SECONDS,
  )
  return seconds * 1000
}

const PS_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']

const TEMPLATE = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'bash.txt'),
  'utf-8',
)

interface ShellConfig {
  shell: string
  args: string[]
  name: string
}

/**
 * Detect available Git Bash path on Windows. Returns null if not found.
 */
function findGitBash(): string | null {
  try {
    const gitResult = crossSpawn.sync('git', ['--exec-path'], { encoding: 'utf-8' })
    if (gitResult.status === 0 && gitResult.stdout) {
      const gitPath = gitResult.stdout.trim()
      const possiblePaths = [
        gitPath.replace(/\/mingw64\/libexec\/git-core$/, '/bin/bash.exe').replace(/\\mingw64\\libexec\\git-core$/, '\\bin\\bash.exe'),
        gitPath.replace(/\/libexec\/git-core$/, '/bin/bash.exe').replace(/\\libexec\\git-core$/, '\\bin\\bash.exe'),
        gitPath.replace(/\/mingw64\/libexec\/git-core$/, '/usr/bin/bash.exe').replace(/\\mingw64\\libexec\\git-core$/, '\\usr\\bin\\bash.exe'),
      ]

      for (const bashPath of possiblePaths) {
        if (bashPath === gitPath) continue
        try {
          const bashResult = crossSpawn.sync(bashPath, ['-c', 'exit 0'], { stdio: 'ignore' })
          if (bashResult.status === 0) {
            return bashPath
          }
        } catch {}
      }
    }
  } catch {}
  return null
}

function getDefaultShellConfig(): ShellConfig {
  if (process.platform === 'darwin') {
    try {
      const result = crossSpawn.sync('zsh', ['-c', 'exit 0'], { stdio: 'ignore' })
      if (result.status === 0) {
        return { shell: 'zsh', args: ['-c'], name: 'zsh' }
      }
    } catch {}
    return { shell: 'bash', args: ['-c'], name: 'bash' }
  }

  if (process.platform !== 'win32') {
    return { shell: 'bash', args: ['-c'], name: 'bash' }
  }

  // Windows: Priority - Git Bash > PowerShell > cmd
  const gitBash = findGitBash()
  if (gitBash) {
    return { shell: gitBash, args: ['-c'], name: 'bash' }
  }

  const psPaths = ['pwsh.exe', 'powershell.exe']
  for (const ps of psPaths) {
    try {
      const result = crossSpawn.sync(ps, ['-Command', 'exit 0'], { stdio: 'ignore' })
      if (result.status === 0) {
        return { shell: ps, args: PS_ARGS, name: ps === 'pwsh.exe' ? 'pwsh' : 'powershell' }
      }
    } catch {}
  }

  return { shell: 'cmd.exe', args: ['/c'], name: 'cmd' }
}

/**
 * Map a user-supplied shell name to a ShellConfig.
 * Does NOT verify availability — caller is expected to call verifyShellAvailable.
 */
function resolveShellConfig(name: 'bash' | 'zsh' | 'sh' | 'powershell' | 'pwsh' | 'cmd'): ShellConfig {
  // 大小写规范化: 容错 'PowerShell' / 'BASH' / 'ZSH' 等输入
  const normalized = name.toLowerCase() as 'bash' | 'zsh' | 'sh' | 'powershell' | 'pwsh' | 'cmd'
  switch (normalized) {
    case 'bash':
      if (process.platform === 'win32') {
        const path = findGitBash()
        if (path) return { shell: path, args: ['-c'], name: 'bash' }
        return { shell: 'bash', args: ['-c'], name: 'bash' } // placeholder; will fail availability
      }
      return { shell: 'bash', args: ['-c'], name: 'bash' }
    case 'zsh':
      return { shell: 'zsh', args: ['-c'], name: 'zsh' }
    case 'sh':
      // POSIX sh: 所有平台统一用 `sh -c "command"`，不可用时由 verifyShellAvailable 拦截
      return { shell: 'sh', args: ['-c'], name: 'sh' }
    case 'powershell':
      return {
        shell: process.platform === 'win32' ? 'powershell.exe' : 'powershell',
        args: PS_ARGS,
        name: 'powershell',
      }
    case 'pwsh':
      return {
        shell: process.platform === 'win32' ? 'pwsh.exe' : 'pwsh',
        args: PS_ARGS,
        name: 'pwsh',
      }
    case 'cmd':
      return {
        shell: process.platform === 'win32' ? 'cmd.exe' : 'cmd',
        args: ['/c'],
        name: 'cmd',
      }
  }
}

const KNOWN_SHELLS = ['bash', 'zsh', 'sh', 'powershell', 'pwsh', 'cmd'] as const

/**
 * Probe whether a shell can actually execute `exit 0`.
 */
function verifyShellAvailable(config: ShellConfig): boolean {
  try {
    const r = crossSpawn.sync(
      config.shell,
      [...config.args, 'exit 0'],
      { stdio: 'ignore' },
    )
    return r.status === 0
  } catch {
    return false
  }
}

/**
 * Return the subset of KNOWN_SHELLS that are available on this platform.
 */
function listAvailableShells(): string[] {
  return KNOWN_SHELLS
    .filter(n => verifyShellAvailable(resolveShellConfig(n)))
}

const defaultShell = getDefaultShellConfig()

// Expose for testing
export { defaultShell, resolveShellConfig, verifyShellAvailable, listAvailableShells }

const chaining =
  defaultShell.name === 'powershell'
    ? "If the commands depend on each other and must run sequentially, avoid '&&' in this shell because Windows PowerShell 5.1 does not support it. Use PowerShell conditionals such as `cmd1; if ($?) { cmd2 }` when later commands must depend on earlier success."
    : "If the commands depend on each other and must run sequentially, use a single Bash call with '&&' to chain them together (e.g., `git add . && git commit -m \"message\" && git push`). For instance, if one operation must complete before another starts (like mkdir before cp, Write before Bash for git operations, or git add before git commit), run these operations sequentially instead."

const DESCRIPTION = TEMPLATE
  .replaceAll('${os}', process.platform)
  .replaceAll('${shell}', defaultShell.name)
  .replaceAll('${chaining}', chaining)
  .replaceAll('${maxLines}', String(MAX_LINES))
  .replaceAll('${maxBytes}', String(MAX_BYTES))

export const BashTool = defineTool({
  name: 'Bash',
  description: DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The bash command to execute',
      },
      description: {
        type: 'string',
        description: [
          'Clear, concise description of what this command does in 5-10 words.',
          'Examples:',
          'Input: ls → Output: Lists files in current directory',
          'Input: git status → Output: Shows working tree status',
          'Input: mkdir foo → Output: 创建目录 \'foo\'',
        ].join('\n'),
      },
      timeout: {
        type: 'number',
        description: 'Optional timeout in seconds (min 1, max 600, default 120)',
        minimum: MIN_TIMEOUT_SECONDS,
        maximum: MAX_TIMEOUT_SECONDS,
      },
      workdir: {
        type: 'string',
        description: 'The working directory to run the command in. Defaults to the current directory. Use this instead of cd commands.',
      },
      shell: {
        type: 'string',
        enum: ['bash', 'zsh', 'sh', 'powershell', 'pwsh', 'cmd'],
        description: [
          'Optional. Specify which shell to use for executing the command.',
          'Default is platform-specific (macOS: zsh/bash, Linux: bash, Windows: Git Bash/PowerShell/cmd).',
          'Note: different shells have different syntax. For example, PowerShell uses ";" and "if ($?)" instead of "&&".',
        ].join(' '),
      },
    },
    required: ['command'],
  },
  isReadOnly: false,
  isConcurrencySafe: false,
  async call(input, context) {
    const { command, shell: userShell, timeout: userTimeout } = input
    // Model-facing unit is seconds (issue #27). Convert + clamp here.
    const timeoutMs = resolveTimeoutMs(
      typeof userTimeout === 'number' && Number.isFinite(userTimeout) ? userTimeout : undefined,
    )
    const timeoutSeconds = timeoutMs / 1000
    const cwd = input.workdir || context.cwd

    // Resolve which shell to use
    let activeShell: ShellConfig
    if (userShell) {
      activeShell = resolveShellConfig(userShell)
      if (!verifyShellAvailable(activeShell)) {
        const available = listAvailableShells().join(', ')
        return {
          data: `Error: Shell "${userShell}" is not available on this platform. Available shells: ${available}`,
          is_error: true,
        }
      }
    } else {
      activeShell = defaultShell
    }

    // PowerShell UTF-8 encoding fix (also applies to pwsh)
    const isPowerShell = activeShell.name === 'powershell' || activeShell.name === 'pwsh'
    const finalCommand = isPowerShell
      ? `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`
      : command

    return new Promise<string | { data: string; is_error: boolean }>((resolve) => {
      const chunks: Buffer[] = []
      const errChunks: Buffer[] = []
      // Set true when OUR timeout timer fires. This is the only reliable way
      // to distinguish "process killed because it exceeded the timeout" from
      // other signal terminations — cross-spawn/Node report both as
      // (code: null, signal: 'SIGTERM').
      let timedOut = false

      const isWindowsPowerShell = process.platform === 'win32' && isPowerShell
      const proc = crossSpawn(activeShell.shell, [...activeShell.args, finalCommand], {
        cwd,
        env: context.subprocessEnv,
        // NB: we do NOT pass `timeout` to spawn — Node's built-in timeout kills
        // only the direct child (the shell), orphaning grandchildren. Our own
        // timer below kills the whole process group, matching the abort path.
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        // Windows PowerShell / pwsh cannot have their stdout/stderr captured via
        // pipe when launched detached (they detect no console and suppress output).
        // Detached is only needed on Unix for reliable process-group killing.
        detached: isWindowsPowerShell ? false : true,
      })

      proc.stdout?.on('data', (data: Buffer) => chunks.push(data))
      proc.stderr?.on('data', (data: Buffer) => errChunks.push(data))

      let killTimer: ReturnType<typeof setTimeout> | undefined
      const killProcess = () => {
          if (process.platform === 'win32') {
            try {
              crossSpawn.sync('taskkill', ['/T', '/F', '/PID', String(proc.pid)], { stdio: 'ignore' })
            } catch {}
            proc.stdout?.destroy()
            proc.stderr?.destroy()
          } else {
            try { process.kill(-proc.pid!, 'SIGTERM') } catch {}
            killTimer = setTimeout(() => {
              try { process.kill(-proc.pid!, 'SIGKILL') } catch {}
            }, 1000)
          }
      }

      // Our own timeout timer. Fires → mark timedOut, kill the process group.
      // The subsequent 'exit' event (code: null, signal: 'SIGTERM') is then
      // attributed to the timeout via the flag.
      const timeoutTimer = setTimeout(() => {
        timedOut = true
        killProcess()
      }, timeoutMs)

      const onAbort = () => killProcess()

      if (context.abortSignal) {
        context.abortSignal.addEventListener('abort', onAbort, { once: true })
      }

      proc.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
        context.abortSignal?.removeEventListener('abort', onAbort)
        clearTimeout(timeoutTimer)
        if (killTimer) clearTimeout(killTimer)

        const stdout = Buffer.concat(chunks).toString('utf-8')
        const stderr = Buffer.concat(errChunks).toString('utf-8')

        let output = ''
        if (stdout) output += stdout
        if (stderr) output += (output ? '\n' : '') + stderr

        if (output.length > MAX_OUTPUT_CHARS) {
          output = output.slice(0, MAX_OUTPUT_CHARS / 2) + '\n...(truncated)...\n' + output.slice(-MAX_OUTPUT_CHARS / 2)
        }

        // Explicit timeout: never report as a successful "(no output)".
        if (timedOut) {
          const message = `Error: Command timed out after ${timeoutSeconds} seconds (limit ${timeoutSeconds}s)`
          resolve({
            data: output ? `${message}\n\nPartial output before timeout:\n${output}` : message,
            is_error: true,
          })
          return
        }

        // Killed by an external signal (e.g. user abort). code is null when a
        // signal terminated the process; treating it as a silent success would
        // hide cancellations the same way the old code hid timeouts.
        if (signal) {
          const message = `Error: Command terminated by signal ${signal}`
          resolve({
            data: output ? `${message}\n\nPartial output before termination:\n${output}` : message,
            is_error: true,
          })
          return
        }

        if (code !== 0 && code !== null) {
          output += `\nExit code: ${code}`
        }

        resolve(output || '(no output)')
      })

      proc.on('error', (err: Error) => {
        clearTimeout(timeoutTimer)
        resolve(`Error executing command: ${err.message}`)
      })
    })
  },
})

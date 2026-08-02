import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import type { ToolContext } from '../types.js'

// Mock cross-spawn: default export is a function (async spawn) with a .sync method
const mockSync = vi.fn()
const mockSpawn = vi.fn()
vi.mock('cross-spawn', () => ({
  default: Object.assign(mockSpawn, { sync: mockSync }),
}))

// Stub process.platform helpers
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
function setPlatform(p: string) {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}
function restorePlatform() {
  Object.defineProperty(process, 'platform', originalPlatform)
}

const { resolveShellConfig, defaultShell } = await import('./bash.js')

describe('resolveShellConfig', () => {
  afterEach(() => {
    restorePlatform()
    vi.clearAllMocks()
  })

  it('maps bash on linux', () => {
    setPlatform('linux')
    const cfg = resolveShellConfig('bash')
    expect(cfg).toEqual({ shell: 'bash', args: ['-c'], name: 'bash' })
  })

  it('maps zsh on darwin', () => {
    setPlatform('darwin')
    const cfg = resolveShellConfig('zsh')
    expect(cfg).toEqual({ shell: 'zsh', args: ['-c'], name: 'zsh' })
  })

  it('maps powershell on win32 to powershell.exe', () => {
    setPlatform('win32')
    const cfg = resolveShellConfig('powershell')
    expect(cfg).toEqual({
      shell: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'],
      name: 'powershell',
    })
  })

  it('maps pwsh on win32 to pwsh.exe', () => {
    setPlatform('win32')
    const cfg = resolveShellConfig('pwsh')
    expect(cfg).toEqual({
      shell: 'pwsh.exe',
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'],
      name: 'pwsh',
    })
  })

  it('maps pwsh on linux to pwsh', () => {
    setPlatform('linux')
    const cfg = resolveShellConfig('pwsh')
    expect(cfg).toEqual({
      shell: 'pwsh',
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'],
      name: 'pwsh',
    })
  })

  it('maps cmd on win32 to cmd.exe', () => {
    setPlatform('win32')
    const cfg = resolveShellConfig('cmd')
    expect(cfg).toEqual({ shell: 'cmd.exe', args: ['/c'], name: 'cmd' })
  })

  it('maps cmd on linux to cmd (will fail availability check at runtime)', () => {
    setPlatform('linux')
    const cfg = resolveShellConfig('cmd')
    expect(cfg).toEqual({ shell: 'cmd', args: ['/c'], name: 'cmd' })
  })

  it('maps bash on win32 to Git Bash path when detected', () => {
    setPlatform('win32')
    // Simulate `git --exec-path` returning a Git for Windows path
    mockSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'git' && args[0] === '--exec-path') {
        return { status: 0, stdout: 'C:\\Program Files\\Git\\mingw64\\libexec\\git-core\n' }
      }
      return { status: 0 }
    })
    const cfg = resolveShellConfig('bash')
    expect(cfg.name).toBe('bash')
    expect(cfg.args).toEqual(['-c'])
    // Should resolve to a bash.exe path under Git installation
    expect(cfg.shell).toMatch(/bash\.exe$/)
  })

  it('maps sh to sh -c on all platforms (linux)', () => {
    setPlatform('linux')
    const cfg = resolveShellConfig('sh')
    expect(cfg).toEqual({ shell: 'sh', args: ['-c'], name: 'sh' })
  })

  it('maps sh to sh -c on all platforms (darwin)', () => {
    setPlatform('darwin')
    const cfg = resolveShellConfig('sh')
    expect(cfg).toEqual({ shell: 'sh', args: ['-c'], name: 'sh' })
  })

  it('maps sh to sh -c on all platforms (win32)', () => {
    setPlatform('win32')
    const cfg = resolveShellConfig('sh')
    expect(cfg).toEqual({ shell: 'sh', args: ['-c'], name: 'sh' })
  })
})

describe('resolveShellConfig case-insensitive normalization', () => {
  afterEach(() => {
    restorePlatform()
    vi.clearAllMocks()
  })

  it('normalizes PowerShell to powershell on win32', () => {
    setPlatform('win32')
    const cfg = resolveShellConfig('PowerShell' as any)
    expect(cfg).toEqual({
      shell: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'],
      name: 'powershell',
    })
  })

  it('normalizes BASH to bash on linux', () => {
    setPlatform('linux')
    const cfg = resolveShellConfig('BASH' as any)
    expect(cfg).toEqual({ shell: 'bash', args: ['-c'], name: 'bash' })
  })

  it('normalizes Zsh to zsh on darwin', () => {
    setPlatform('darwin')
    const cfg = resolveShellConfig('Zsh' as any)
    expect(cfg).toEqual({ shell: 'zsh', args: ['-c'], name: 'zsh' })
  })

  it('normalizes SH to sh', () => {
    setPlatform('linux')
    const cfg = resolveShellConfig('SH' as any)
    expect(cfg).toEqual({ shell: 'sh', args: ['-c'], name: 'sh' })
  })
})

describe('defaultShell', () => {
  it('is a valid ShellConfig object', () => {
    expect(defaultShell).toBeDefined()
    expect(defaultShell.name).toBeTruthy()
    expect(Array.isArray(defaultShell.args)).toBe(true)
  })
})

const { verifyShellAvailable, listAvailableShells } = await import('./bash.js')

describe('verifyShellAvailable', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns true when spawn reports status 0', () => {
    mockSync.mockReturnValue({ status: 0 })
    expect(verifyShellAvailable({ shell: 'bash', args: ['-c'], name: 'bash' })).toBe(true)
    expect(mockSync).toHaveBeenCalledWith('bash', ['-c', 'exit 0'], { stdio: 'ignore' })
  })

  it('returns false when spawn reports non-zero status', () => {
    mockSync.mockReturnValue({ status: 127 })
    expect(verifyShellAvailable({ shell: 'nonexistent', args: ['-c'], name: 'bash' })).toBe(false)
  })

  it('returns false when spawn throws', () => {
    mockSync.mockImplementation(() => { throw new Error('ENOENT') })
    expect(verifyShellAvailable({ shell: 'nope', args: ['-c'], name: 'bash' })).toBe(false)
  })
})

describe('listAvailableShells', () => {
  afterEach(() => {
    restorePlatform()
    vi.clearAllMocks()
  })

  it('includes bash when verifyShellAvailable returns true for bash', () => {
    setPlatform('linux')
    mockSync.mockReturnValue({ status: 0 }) // all shells "available"
    const list = listAvailableShells()
    expect(list).toContain('bash')
    expect(list).toContain('zsh')
  })

  it('excludes shells that fail availability check', () => {
    setPlatform('linux')
    mockSync.mockImplementation((cmd: string) => {
      // Only bash is available
      if (cmd === 'bash') return { status: 0 }
      return { status: 127 }
    })
    const list = listAvailableShells()
    expect(list).toEqual(['bash'])
  })
})

const { BashTool } = await import('./bash.js')

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: process.cwd(),
    agentId: 'test',
    model: 'test',
    provider: {} as any,
    agents: {},
    ...overrides,
  }
}

/**
 * Set up mockSpawn to simulate a child process that emits stdout and exits 0.
 */
function mockSuccessfulRun(stdout = 'ok\n') {
  mockSpawn.mockImplementation(() => {
    const proc = new EventEmitter()
    ;(proc as any).stdout = new EventEmitter()
    ;(proc as any).stderr = new EventEmitter()
    ;(proc as any).pid = 12345
    setTimeout(() => {
      ;(proc as any).stdout.emit('data', Buffer.from(stdout))
      proc.emit('exit', 0)
    }, 0)
    return proc as any
  })
}

describe('BashTool.call shell selection', () => {
  afterEach(() => {
    restorePlatform()
    vi.clearAllMocks()
  })

  it('uses default shell when shell param is omitted', async () => {
    mockSuccessfulRun('done')

    const result = await BashTool.call({ command: 'echo hi' } as any, makeContext()) as any

    expect(mockSpawn).toHaveBeenCalledTimes(1)
    const [spawnCmd, spawnArgs] = mockSpawn.mock.calls[0]
    // Default shell is a module-level constant computed at import time;
    // we can't change it via setPlatform, so assert it matches defaultShell
    expect(spawnCmd).toBe(defaultShell.shell)
    expect(spawnArgs[spawnArgs.length - 1]).toBe('echo hi')
    expect(result.content).toContain('done')
  })

  it('uses requested shell when shell param is provided', async () => {
    setPlatform('linux')
    // Mock verifyShellAvailable: bash and zsh available, others not
    mockSync.mockImplementation((cmd: string) => {
      if (cmd === 'bash' || cmd === 'zsh') return { status: 0 }
      return { status: 127 }
    })
    mockSuccessfulRun('zsh output')

    const result = await BashTool.call(
      { command: 'echo $SHELL', shell: 'zsh' } as any,
      makeContext(),
    ) as any

    expect(mockSpawn).toHaveBeenCalledTimes(1)
    const [spawnCmd] = mockSpawn.mock.calls[0]
    expect(spawnCmd).toBe('zsh')
    expect(result.content).toContain('zsh output')
  })

  it('returns error string when requested shell is unavailable', async () => {
    setPlatform('linux')
    // All spawn.sync probes fail
    mockSync.mockReturnValue({ status: 127 })
    mockSuccessfulRun('should not run')

    const result = await BashTool.call(
      { command: 'echo hi', shell: 'powershell' } as any,
      makeContext(),
    ) as any

    // Result should be a tool_result with is_error true and message about availability
    expect(result.is_error).toBe(true)
    expect(result.content).toMatch(/not available/)
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('injects UTF-8 prefix when shell is pwsh', async () => {
    setPlatform('linux')
    mockSync.mockImplementation((cmd: string) => {
      if (cmd === 'pwsh') return { status: 0 }
      return { status: 127 }
    })
    mockSuccessfulRun('done')

    await BashTool.call(
      { command: 'Get-Date', shell: 'pwsh' } as any,
      makeContext(),
    )

    const spawnArgs = mockSpawn.mock.calls[0][1]
    const actualCommand = spawnArgs[spawnArgs.length - 1]
    expect(actualCommand).toContain('[Console]::OutputEncoding')
    expect(actualCommand).toContain('Get-Date')
  })

  it('does not inject UTF-8 prefix when shell is bash', async () => {
    setPlatform('linux')
    // bash must be available so verifyShellAvailable passes and spawn is called
    mockSync.mockImplementation((cmd: string) => {
      if (cmd === 'bash') return { status: 0 }
      return { status: 127 }
    })
    mockSuccessfulRun('done')

    await BashTool.call(
      { command: 'echo hi', shell: 'bash' } as any,
      makeContext(),
    )

    const spawnArgs = mockSpawn.mock.calls[0][1]
    const actualCommand = spawnArgs[spawnArgs.length - 1]
    expect(actualCommand).not.toContain('[Console]::OutputEncoding')
  })
})

describe('BashTool.call cancellation lifecycle', () => {
  afterEach(() => {
    restorePlatform()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('does not kill a completed shell process group when the signal aborts later', async () => {
    setPlatform('linux')
    vi.useFakeTimers()
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const controller = new AbortController()
    mockSuccessfulRun('done')

    const result = BashTool.call(
      { command: 'npm run dev &' } as any,
      makeContext({ abortSignal: controller.signal }),
    )
    await vi.advanceTimersByTimeAsync(0)
    await result

    controller.abort()

    expect(kill).not.toHaveBeenCalled()
  })
})

describe('BashTool.inputSchema', () => {
  it('declares shell as an enum field', () => {
    const schema = BashTool.inputSchema as any
    expect(schema.properties.shell).toBeDefined()
    expect(schema.properties.shell.enum).toEqual(['bash', 'zsh', 'sh', 'powershell', 'pwsh', 'cmd'])
    expect(schema.required).not.toContain('shell')
  })
})

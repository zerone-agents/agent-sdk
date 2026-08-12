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
    subprocessEnv: { ...process.env },
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
      proc.emit('exit', 0, null)
    }, 0)
    return proc as any
  })
}

/**
 * Set up mockSpawn to simulate a child process that never exits on its own.
 * Returns the proc so tests can emit events manually (e.g. after advancing
 * fake timers past the timeout).
 */
function mockHangingRun() {
  const proc = new EventEmitter()
  ;(proc as any).stdout = new EventEmitter()
  ;(proc as any).stderr = new EventEmitter()
  ;(proc as any).pid = 12345
  mockSpawn.mockImplementation(() => proc as any)
  return proc
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

  it('documents timeout in seconds with explicit bounds (issue #27)', () => {
    const schema = BashTool.inputSchema as any
    const timeout = schema.properties.timeout
    expect(timeout).toBeDefined()
    expect(timeout.minimum).toBe(1)
    expect(timeout.maximum).toBe(600)
    expect(timeout.description).toContain('seconds')
    expect(timeout.description).not.toContain('milliseconds')
  })
})

const { resolveTimeoutMs } = await import('./bash.js')

describe('resolveTimeoutMs (issue #27: seconds unit)', () => {
  it('defaults to 120 seconds when timeout is omitted', () => {
    expect(resolveTimeoutMs(undefined)).toBe(120_000)
  })

  it('converts seconds to milliseconds (15 → 15000, the exact misuse case from the issue)', () => {
    expect(resolveTimeoutMs(15)).toBe(15_000)
  })

  it('clamps to a minimum of 1 second', () => {
    expect(resolveTimeoutMs(0)).toBe(1_000)
    expect(resolveTimeoutMs(-5)).toBe(1_000)
  })

  it('clamps to a maximum of 600 seconds', () => {
    expect(resolveTimeoutMs(9999)).toBe(600_000)
    expect(resolveTimeoutMs(15000)).toBe(600_000) // legacy ms-style input is clamped, not silently honored
  })

  it('accepts fractional seconds within bounds', () => {
    expect(resolveTimeoutMs(2.5)).toBe(2_500)
  })
})

describe('BashTool.call timeout semantics (issue #27)', () => {
  afterEach(() => {
    restorePlatform()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('a successful command with no output still resolves to "(no output)" success', async () => {
    setPlatform('linux')
    // default shell is computed at import; mockSuccessfulRun works for any shell
    mockSpawn.mockImplementation(() => {
      const proc = new EventEmitter()
      ;(proc as any).stdout = new EventEmitter()
      ;(proc as any).stderr = new EventEmitter()
      ;(proc as any).pid = 12345
      setTimeout(() => proc.emit('exit', 0, null), 0)
      return proc as any
    })

    const result = await BashTool.call({ command: 'true' } as any, makeContext()) as any
    expect(result.content).toBe('(no output)')
    expect(result.is_error).toBe(false)
  })

  it('timeout: 15 means 15 SECONDS — a fast command is not killed (issue repro)', async () => {
    setPlatform('linux')
    vi.useFakeTimers()
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    mockSuccessfulRun('streamed-result')

    const promise = BashTool.call({ command: 'sleep 0.05; printf streamed-result', timeout: 15 } as any, makeContext())
    await vi.advanceTimersByTimeAsync(0) // mock emits data + exit(0)
    const result = (await promise) as any

    expect(result.content).toContain('streamed-result')
    expect(result.is_error).toBe(false)
    expect(kill).not.toHaveBeenCalled()
  })

  it('a command killed by timeout returns an error result, never "(no output)" success', async () => {
    setPlatform('linux')
    vi.useFakeTimers()
    vi.spyOn(process, 'kill').mockImplementation(() => true)
    const proc = mockHangingRun()

    const promise = BashTool.call({ command: 'sleep 999', timeout: 1 } as any, makeContext())
    // advance past the 1s timeout → tool marks timedOut and kills the group
    await vi.advanceTimersByTimeAsync(1_000)
    // simulate the OS reporting signal termination (code null, signal SIGTERM)
    proc.emit('exit', null, 'SIGTERM')
    const result = (await promise) as any

    expect(result.is_error).toBe(true)
    expect(result.content).toContain('timed out after 1 seconds')
    expect(result.content).not.toBe('(no output)')
  })

  it('timeout error includes partial output captured before the kill', async () => {
    setPlatform('linux')
    vi.useFakeTimers()
    vi.spyOn(process, 'kill').mockImplementation(() => true)
    const proc = mockHangingRun()

    const promise = BashTool.call({ command: 'printf progress; sleep 999', timeout: 2 } as any, makeContext())
    ;(proc as any).stdout.emit('data', Buffer.from('progress'))
    await vi.advanceTimersByTimeAsync(2_000)
    proc.emit('exit', null, 'SIGTERM')
    const result = (await promise) as any

    expect(result.is_error).toBe(true)
    expect(result.content).toContain('timed out after 2 seconds')
    expect(result.content).toContain('progress')
  })

  it('clamps sub-1s input up to the 1-second minimum (timeout fires at 1000ms, not earlier)', async () => {
    setPlatform('linux')
    vi.useFakeTimers()
    vi.spyOn(process, 'kill').mockImplementation(() => true)
    const proc = mockHangingRun()

    const promise = BashTool.call({ command: 'sleep 999', timeout: 0 } as any, makeContext())
    await vi.advanceTimersByTimeAsync(999)
    expect(process.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    proc.emit('exit', null, 'SIGTERM')
    const result = (await promise) as any
    expect(result.is_error).toBe(true)
    expect(result.content).toContain('timed out after 1 seconds')
  })

  it('clamps oversized input down to 600 seconds (legacy ms-style 15000 → 600s)', async () => {
    setPlatform('linux')
    vi.useFakeTimers()
    vi.spyOn(process, 'kill').mockImplementation(() => true)
    const proc = mockHangingRun()

    const promise = BashTool.call({ command: 'sleep 999', timeout: 15000 } as any, makeContext())
    await vi.advanceTimersByTimeAsync(599_999)
    expect(process.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    proc.emit('exit', null, 'SIGTERM')
    const result = (await promise) as any
    expect(result.is_error).toBe(true)
    expect(result.content).toContain('timed out after 600 seconds')
  })

  it('a command terminated by an external signal (abort) returns an error result', async () => {
    setPlatform('linux')
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const controller = new AbortController()
    const proc = mockHangingRun()

    const promise = BashTool.call(
      { command: 'sleep 999' } as any,
      makeContext({ abortSignal: controller.signal }),
    )
    controller.abort()
    // OS reports signal termination
    proc.emit('exit', null, 'SIGTERM')
    const result = (await promise) as any

    expect(kill).toHaveBeenCalled()
    expect(result.is_error).toBe(true)
    expect(result.content).toContain('terminated by signal SIGTERM')
    expect(result.content).not.toBe('(no output)')
  })

  it('spawn-level errors still resolve with an error message and clear the timeout timer', async () => {
    setPlatform('linux')
    vi.useFakeTimers()
    const proc = mockHangingRun()

    const promise = BashTool.call({ command: 'whatever' } as any, makeContext())
    proc.emit('error', new Error('spawn ENOENT'))
    const result = (await promise) as any

    expect(result.content).toContain('Error executing command')
    expect(result.content).toContain('spawn ENOENT')
    // advancing far past the default timeout must not kill anything or double-resolve
    await vi.advanceTimersByTimeAsync(200_000)
  })
})


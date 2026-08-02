import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { SnapshotEngine, SnapshotTimeoutError } from './index.js'

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}))

describe('SnapshotEngine timeout', () => {
  let worktree: string

  beforeEach(async () => {
    worktree = await mkdtemp(join(tmpdir(), 'snap-timeout-test-'))
  })

  afterEach(async () => {
    await rm(worktree, { recursive: true, force: true })
    await rm(worktree + '-snapshot', { recursive: true, force: true }).catch(() => {})
  })

  it('throws SnapshotTimeoutError when git command times out', async () => {
    const { execFile } = await import('child_process')
    ;(execFile as any).mockImplementation((_cmd: string, _args: string[], opts: any, cb: any) => {
      const timer = setTimeout(() => {
        const err = Object.assign(new Error('ETIMEDOUT'), { killed: true, code: 'ETIMEDOUT' })
        cb(err, { stdout: '', stderr: '' })
      }, opts.timeout)
      return { kill: vi.fn((signal?: string) => clearTimeout(timer)) }
    })

    const engine = new SnapshotEngine({
      worktree,
      snapshotDir: worktree + '-snapshot',
      timeoutMs: 50,
    })

    await expect(engine.init()).rejects.toThrow(SnapshotTimeoutError)
    await expect(engine.init()).rejects.toThrow(/timed out after 50ms/)
  })

  it('uses default timeout of 5000ms when not specified', async () => {
    const { execFile } = await import('child_process')
    let usedTimeout: number | undefined
    ;(execFile as any).mockImplementation((_cmd: string, _args: string[], opts: any, cb: any) => {
      usedTimeout = opts.timeout
      cb(null, { stdout: '', stderr: '' })
      return { kill: vi.fn() }
    })

    const engine = new SnapshotEngine({
      worktree,
      snapshotDir: worktree + '-snapshot',
    })
    await engine.init()

    expect(usedTimeout).toBe(5000)
  })

  it('cancels in-flight operation when external signal is aborted', async () => {
    const { execFile } = await import('child_process')
    ;(execFile as any).mockImplementation((_cmd: string, _args: string[], opts: any, cb: any) => {
      const timer = setTimeout(() => {
        const err = Object.assign(new Error('ETIMEDOUT'), { killed: true, code: 'ETIMEDOUT' })
        cb(err, { stdout: '', stderr: '' })
      }, opts.timeout)
      return { kill: vi.fn((signal?: string) => clearTimeout(timer)) }
    })

    const controller = new AbortController()
    const engine = new SnapshotEngine({
      worktree,
      snapshotDir: worktree + '-snapshot',
      timeoutMs: 1000,
      signal: controller.signal,
    })

    const promise = engine.init()
    controller.abort()

    await expect(promise).rejects.toThrow()
  })

  it('releases lock after timeout so subsequent operations can proceed', async () => {
    const { execFile } = await import('child_process')
    let call = 0
    ;(execFile as any).mockImplementation((_cmd: string, _args: string[], opts: any, cb: any) => {
      call++
      if (call === 1) {
        const timer = setTimeout(() => {
          const err = Object.assign(new Error('ETIMEDOUT'), { killed: true, code: 'ETIMEDOUT' })
          cb(err, { stdout: '', stderr: '' })
        }, opts.timeout)
        return { kill: vi.fn((signal?: string) => clearTimeout(timer)) }
      }
      cb(null, { stdout: '', stderr: '' })
      return { kill: vi.fn() }
    })

    const engine = new SnapshotEngine({
      worktree,
      snapshotDir: worktree + '-snapshot',
      timeoutMs: 50,
    })

    await expect(engine.init()).rejects.toThrow(SnapshotTimeoutError)
    await expect(engine.init()).resolves.toBeUndefined()
    expect(call).toBe(2)
  })
})

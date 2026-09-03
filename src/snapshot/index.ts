import { execFile } from 'child_process'
import { promisify } from 'util'
import { createHash } from 'crypto'
import { homedir } from 'os'
import { mkdir, rm, readFile, writeFile, stat } from 'fs/promises'
import { join } from 'path'
import { Semaphore, getLock } from './semaphore.js'
import { createDiagnosticsSink, stableErrorType, type DiagnosticsSink } from '../utils/diagnostics.js'

const execFileAsync = promisify(execFile)

export class SnapshotTimeoutError extends Error {
  /** The original error that caused the timeout classification (#78 R1). */
  declare readonly cause?: unknown
  constructor(operation: string, timeoutMs: number, original?: unknown) {
    super(`Snapshot operation "${operation}" timed out after ${timeoutMs}ms`)
    this.name = 'SnapshotTimeoutError'
    if (original !== undefined) this.cause = original
  }
}

const LARGE_FILE_LIMIT = 2 * 1024 * 1024 // 2MB

export interface SnapshotEngineOptions {
  worktree: string
  /** Snapshot repo directory. Defaults to ~/.agents/snapshot/<project-hash>/<worktree-hash>/ */
  snapshotDir?: string
  /** Timeout for each git operation in milliseconds. Defaults to 5000. */
  timeoutMs?: number
  /** Optional external abort signal to cancel in-flight git operations. */
  signal?: AbortSignal
  /** Optional diagnostics sink (#78); defaults to the console-backed sink. */
  diagnostics?: DiagnosticsSink
}

/**
 * Compute the default snapshot directory for a worktree.
 *
 * Layout: ~/.agents/snapshot/<project-hash>/<worktree-hash>/
 *
 * - project-hash: groups all worktrees of the same project together.
 *   Derived from git remote URL, or directory path as fallback.
 * - worktree-hash: identifies the specific worktree path.
 */
async function defaultSnapshotDir(worktree: string): Promise<string> {
  const projectHash = await computeProjectHash(worktree)
  const worktreeHash = createHash('sha256').update(worktree).digest('hex').slice(0, 16)
  return join(homedir(), '.agents', 'snapshot', projectHash, worktreeHash)
}

/**
 * Derive a project-level hash from a worktree path.
 *
 * Strategy:
 * 1. If git repo with remote → hash the remote URL (same project across clones/worktrees)
 * 2. Otherwise → hash the absolute directory path
 */
async function computeProjectHash(worktree: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
      cwd: worktree,
      env: { ...process.env },
    })
    const remote = stdout.trim()
    if (remote) {
      return createHash('sha256').update(remote).digest('hex').slice(0, 16)
    }
  } catch {
    // not a git repo or no remote — fall through
  }
  // Fallback: hash the directory path (without trailing slash)
  return createHash('sha256').update(worktree.replace(/\/$/, '')).digest('hex').slice(0, 16)
}

export interface RevertEntry {
  hash: string
  path: string
}

export class SnapshotEngine {
  private worktree: string
  private _gitDir?: string
  private lock = new Semaphore()
  private timeoutMs: number
  private signal?: AbortSignal
  private abortController: AbortController
  private diagnostics: DiagnosticsSink

  constructor(opts: SnapshotEngineOptions) {
    this.worktree = opts.worktree
    this._gitDir = opts.snapshotDir
    this.timeoutMs = opts.timeoutMs ?? 5000
    this.diagnostics = opts.diagnostics ?? createDiagnosticsSink()
    this.signal = opts.signal
    this.abortController = new AbortController()
    if (this.signal) {
      this.signal.addEventListener('abort', () => this.abortController.abort(), { once: true })
    }
  }

  /** Shared timeout classification for the sync/async paths (#78 R1 dedup):
   *  sanitized warn (raw error on cause) + throw preserving the original. */
  private failSnapshotTimeout(operation: string, err: unknown): never {
    this.diagnostics.warn(
      `[Snapshot] Snapshot operation "${operation}" timed out after ${this.timeoutMs}ms`,
      { errorType: stableErrorType(err) },
      err,
    )
    throw new SnapshotTimeoutError(operation, this.timeoutMs, err)
  }

  /** Snapshot repo path. Available after init(). */
  private get gitDir(): string {
    if (!this._gitDir) throw new Error('SnapshotEngine not initialized — call init() first')
    return this._gitDir
  }

  /**
   * Initialize the snapshot git repo.
   * Creates a bare repo and syncs ignore rules from the source repo.
   */
  async init(): Promise<void> {
    // Resolve default path if not explicitly provided
    if (!this._gitDir) {
      this._gitDir = await defaultSnapshotDir(this.worktree)
    }

    // Switch to shared lock (by gitDir) for cross-instance safety
    this.lock = getLock(this._gitDir)

    await this.lock.acquire(this.timeoutMs * 2)
    try {
      await mkdir(this.gitDir, { recursive: true })
      await this.execRaw(['init', '--bare', this.gitDir])
      await this.syncIgnoreRules()
    } finally {
      this.lock.release()
    }
  }

  /**
   * Run a git command with GIT_DIR and GIT_WORK_TREE set.
   */
  private async exec(args: string[], operation = args[0]): Promise<{ stdout: string; stderr: string }> {
    try {
      return await execFileAsync('git', args, {
        env: {
          ...process.env,
          GIT_DIR: this.gitDir,
          GIT_WORK_TREE: this.worktree,
        },
        maxBuffer: 50 * 1024 * 1024,
        timeout: this.timeoutMs,
        killSignal: 'SIGTERM',
      })
    } catch (err: any) {
      if (err.killed || err.code === 'ETIMEDOUT') {
        this.failSnapshotTimeout(operation, err)
      }
      throw err
    }
  }

  /**
   * Run a git command without GIT_DIR/GIT_WORK_TREE (for init).
   */
  private async execRaw(args: string[], cwd?: string, operation = args[0]): Promise<{ stdout: string; stderr: string }> {
    try {
      return await execFileAsync('git', args, {
        env: { ...process.env },
        maxBuffer: 50 * 1024 * 1024,
        cwd,
        timeout: this.timeoutMs,
        killSignal: 'SIGTERM',
      })
    } catch (err: any) {
      if (err.killed || err.code === 'ETIMEDOUT') {
        this.failSnapshotTimeout(operation, err)
      }
      throw err
    }
  }

  /**
   * Sync ignore rules from the source repo's .git/info/exclude.
   */
  private async syncIgnoreRules(): Promise<void> {
    try {
      const sourceExclude = join(this.worktree, '.git', 'info', 'exclude')
      const content = await readFile(sourceExclude, 'utf-8')
      const targetExclude = join(this.gitDir, 'info', 'exclude')
      await mkdir(join(this.gitDir, 'info'), { recursive: true })
      await writeFile(targetExclude, content, 'utf-8')
    } catch {
      // no source exclude — skip
    }
  }

  /**
   * Snapshot the current workspace state.
   * Returns a tree hash that can be used to restore or revert later.
   */
  async track(): Promise<string> {
    await this.lock.acquire(this.timeoutMs * 2)
    try {
      await this.filterLargeUntracked()
      await this.exec(['add', '--all'])
      const { stdout } = await this.exec(['write-tree'])
      return stdout.trim()
    } finally {
      this.lock.release()
    }
  }

  /**
   * Remove large untracked files from the index and add them to exclude.
   */
  private async filterLargeUntracked(): Promise<void> {
    try {
      const { stdout } = await this.exec(['status', '--porcelain', '--untracked-files=all'])
      const excludeAdditions: string[] = []

      for (const line of stdout.split('\n')) {
        if (!line.startsWith('??')) continue
        const filePath = line.slice(3).trim().replace(/"/g, '')
        if (!filePath) continue

        try {
          const full = join(this.worktree, filePath)
          const s = await stat(full)
          if (s.size > LARGE_FILE_LIMIT) {
            excludeAdditions.push(filePath)
          }
        } catch {
          // stat failed — skip
        }
      }

      if (excludeAdditions.length > 0) {
        const targetExclude = join(this.gitDir, 'info', 'exclude')
        const existing = await readFile(targetExclude, 'utf-8').catch(() => '')
        const additions = excludeAdditions
          .filter((p) => !existing.includes(p))
          .join('\n')
        if (additions) {
          await writeFile(targetExclude, existing + '\n' + additions + '\n', 'utf-8')
        }
      }
    } catch {
      // non-fatal
    }
  }

  /**
   * Restore the entire workspace to a snapshot state.
   */
  async restore(hash: string): Promise<void> {
    await this.lock.acquire(this.timeoutMs * 2)
    try {
      await this.exec(['read-tree', hash])
      await this.exec(['checkout-index', '-a', '-f'])
    } finally {
      this.lock.release()
    }
  }

  /**
   * List files changed since the given snapshot hash.
   */
  async patchList(fromHash: string): Promise<string[]> {
    await this.lock.acquire(this.timeoutMs * 2)
    try {
      await this.filterLargeUntracked()
      await this.exec(['add', '--all'])
      const { stdout } = await this.exec(['diff', '--cached', '--name-only', fromHash])
      return stdout.trim().split('\n').filter(Boolean)
    } finally {
      this.lock.release()
    }
  }

  /**
   * Generate a unified diff between a snapshot and the current workspace.
   * Returns an empty string if the snapshot hash is no longer available.
   */
  async diff(fromHash: string): Promise<string> {
    await this.lock.acquire(this.timeoutMs * 2)
    try {
      await this.filterLargeUntracked()
      await this.exec(['add', '--all'])
      const { stdout } = await this.exec(['diff', '--cached', fromHash])
      return stdout
    } catch {
      // Snapshot hash may have been pruned by gc.
      return ''
    } finally {
      this.lock.release()
    }
  }

  /**
   * Revert specific files to their state at a given snapshot.
   * Files that did not exist in the snapshot are deleted.
   *
   * If a snapshot hash is missing (e.g. pruned by gc or corrupted), the
   * entry is skipped silently. The caller (revertSession) still falls back
   * to conversation-only revert.
   */
  async revert(entries: RevertEntry[]): Promise<void> {
    await this.lock.acquire(this.timeoutMs * 2)
    try {
      for (const entry of entries) {
        const fullPath = join(this.worktree, entry.path)
        try {
          // Verify the snapshot still exists. `ls-tree` on a missing hash
          // will throw — in that case we skip this file.
          await this.exec(['ls-tree', entry.hash, '--', entry.path])
          await this.exec(['checkout', entry.hash, '--', entry.path])
        } catch {
          // Snapshot missing or file did not exist in that snapshot.
          // Try to remove the file; if that fails too, leave it alone.
          try {
            await rm(fullPath, { recursive: true, force: true })
          } catch {
            // already gone — fine
          }
        }
      }
    } finally {
      this.lock.release()
    }
  }

  /**
   * Run git gc to prune unreachable objects older than 7 days.
   * This is best-effort and non-fatal. Callers should invoke it once
   * when shutting down an agent (e.g. in Agent.close()).
   */
  async gc(): Promise<void> {
    await this.lock.acquire(this.timeoutMs * 2)
    try {
      await this.exec(['gc', '--prune=7.days', '--quiet'])
    } catch {
      // non-fatal — gc is best-effort
    } finally {
      this.lock.release()
    }
  }
}

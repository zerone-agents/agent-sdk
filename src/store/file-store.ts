/**
 * FileSessionStore——文件持久化 SessionStore（issue #131 P3 T7）。
 *
 * 复用 InMemorySessionStore 全部校验/apply/CAS/去重/fencing 逻辑；单文件
 * `<dir>/sessions.json` 承载全量快照，temp+rename 原子落盘。模块级目录锁
 * 串行化同进程多实例；写路径 = 锁内 reload（拾取他实例已落盘写入，防止
 * 旧内存快照覆盖）→ super 提交 → flush。跨进程无锁（单进程多实例场景）。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { InMemorySessionStore, type StoreSnapshot } from './in-memory.js'
import type { AuthorizationContext, PreparedOperation } from './types.js'
import type { CommitEntryOpts } from './session-store.js'

/** 模块级目录锁：同进程多实例按文件路径串行（issue #131 P3）。 */
const dirLocks = new Map<string, Promise<unknown>>()

export interface FileSessionStoreOptions {
  /** 快照文件所在目录（`<dir>/sessions.json`，目录自动创建）。 */
  dir: string
  receiptRetentionMs?: number
  fencing?: { initialAuth: AuthorizationContext }
}

export class FileSessionStore extends InMemorySessionStore {
  private readonly file: string
  private hydrated = false

  constructor(opts: FileSessionStoreOptions) {
    super({
      ...(opts.receiptRetentionMs !== undefined ? { receiptRetentionMs: opts.receiptRetentionMs } : {}),
      ...(opts.fencing !== undefined ? { fencing: opts.fencing } : {}),
    })
    this.file = join(opts.dir, 'sessions.json')
  }

  /** 目录锁：同路径的临界段串行执行（前段失败不阻塞后段）。 */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = dirLocks.get(this.file) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    dirLocks.set(this.file, run.then(() => undefined, () => undefined))
    return run
  }

  private async readDisk(): Promise<StoreSnapshot | null> {
    try {
      const raw = await readFile(this.file, 'utf8')
      return JSON.parse(raw) as StoreSnapshot
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  /** 首次访问懒水合（文件不存在 → 全新 store）。 */
  private async hydrateOnce(): Promise<void> {
    if (this.hydrated) return
    const snap = await this.readDisk()
    if (snap !== null) this.hydrateStoreSnapshot(snap)
    this.hydrated = true
  }

  /** 写前重载：拾取同目录其他实例已落盘的写入（防止旧内存快照覆盖它们）。 */
  private async reloadFromDisk(): Promise<void> {
    const snap = await this.readDisk()
    if (snap !== null) this.hydrateStoreSnapshot(snap)
  }

  /** 原子落盘：temp 写入 + rename。 */
  private async flush(): Promise<void> {
    const snap = this.exportStoreSnapshot()
    await mkdir(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, JSON.stringify(snap), 'utf8')
    await rename(tmp, this.file)
  }

  // ── 读路径：懒水合后委托 super ──

  override async loadSession(...args: Parameters<InMemorySessionStore['loadSession']>): ReturnType<InMemorySessionStore['loadSession']> {
    await this.withLock(() => this.hydrateOnce())
    return super.loadSession(...args)
  }

  override async loadContext(...args: Parameters<InMemorySessionStore['loadContext']>): ReturnType<InMemorySessionStore['loadContext']> {
    await this.withLock(() => this.hydrateOnce())
    return super.loadContext(...args)
  }

  override async loadRecords(...args: Parameters<InMemorySessionStore['loadRecords']>): ReturnType<InMemorySessionStore['loadRecords']> {
    await this.withLock(() => this.hydrateOnce())
    return super.loadRecords(...args)
  }

  override async loadTodos(...args: Parameters<InMemorySessionStore['loadTodos']>): ReturnType<InMemorySessionStore['loadTodos']> {
    await this.withLock(() => this.hydrateOnce())
    return super.loadTodos(...args)
  }

  override async queryOperation(...args: Parameters<InMemorySessionStore['queryOperation']>): ReturnType<InMemorySessionStore['queryOperation']> {
    await this.withLock(() => this.hydrateOnce())
    return super.queryOperation(...args)
  }

  // ── 写路径：锁内 hydrate → reload（拾取他实例写入）→ super → flush ──

  override async commit(sessionId: string, prepared: PreparedOperation, opts?: CommitEntryOpts): Promise<ReturnType<InMemorySessionStore['commit']> extends Promise<infer R> ? R : never> {
    return this.withLock(async () => {
      await this.hydrateOnce()
      await this.reloadFromDisk()
      const receipt = await super.commit(sessionId, prepared, opts)
      await this.flush()
      return receipt
    })
  }

  override async saveTodos(sessionId: string, prepared: PreparedOperation, opts?: CommitEntryOpts): Promise<ReturnType<InMemorySessionStore['saveTodos']> extends Promise<infer R> ? R : never> {
    return this.withLock(async () => {
      await this.hydrateOnce()
      await this.reloadFromDisk()
      const receipt = await super.saveTodos(sessionId, prepared, opts)
      await this.flush()
      return receipt
    })
  }

  override async deleteSession(sessionId: string, prepared: PreparedOperation, opts?: CommitEntryOpts): Promise<ReturnType<InMemorySessionStore['deleteSession']> extends Promise<infer R> ? R : never> {
    return this.withLock(async () => {
      await this.hydrateOnce()
      await this.reloadFromDisk()
      const receipt = await super.deleteSession(sessionId, prepared, opts)
      await this.flush()
      return receipt
    })
  }

  /** fencing 刷新也持久化（同步签名约束——fire-and-forget 落盘）。 */
  override refreshAuthorization(auth: AuthorizationContext): void {
    super.refreshAuthorization(auth)
    void this.withLock(() => this.flush()).catch(() => {})
  }
}
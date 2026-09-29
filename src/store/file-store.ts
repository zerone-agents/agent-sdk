/**
 * FileSessionStore——文件持久化 SessionStore（issue #131 P3 T7；评审 R4/R5/R6 事务化重做）。
 *
 * 一致性模型：
 * - **读穿（read-through，评审 R5）**：每个公开读入口在目录锁内先从磁盘 reload 最新
 *   快照再委托 super——任何实例已落盘的写入对其他实例立即可见，无陈旧读；
 *   queryOperation 不误报 not-committed。
 * - **事务写（评审 R4）**：三个写入口统一 `transaction` 包装 = 锁内 reload → 内存快照
 *   → super 提交 → flush 落盘；flush 失败 → 内存回滚到快照并抛错——持久化与可见
 *   状态发布是同一提交边界，绝无「已返回 committed 但磁盘无数据」。
 * - **授权事务（评审 R6）**：refresh/expire 在锁内 reload → 修改 → 可靠落盘（错误传播，
 *   不 fire-and-forget）；过期（null）状态同样持久化，不会被写前 reload 从磁盘复活。
 *
 * 跨进程无锁（单进程多实例经模块级目录锁串行）；落盘 = temp+rename 原子替换。
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

  /** 锁内重载磁盘快照（读穿与事务写的共同前置：内存 === 磁盘最新）。 */
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

  /** 读穿：锁内 reload 最新快照后委托 super（评审 R5——跨实例无陈旧读）。 */
  private readThrough<T>(read: () => Promise<T>): Promise<T> {
    return this.withLock(async () => {
      await this.reloadFromDisk()
      return read()
    })
  }

  /** 事务：锁内 reload → 快照 → 提交 → flush；任一步失败回滚内存（评审 R4——提交边界）。 */
  private transaction<T>(mutate: () => Promise<T>): Promise<T> {
    return this.withLock(async () => {
      await this.reloadFromDisk()
      const snapshot = this.exportStoreSnapshot()
      let result: T
      try {
        result = await mutate()
        await this.flush()
      } catch (err) {
        this.hydrateStoreSnapshot(snapshot)   // 回滚到事务前状态（= 磁盘现状）
        throw err
      }
      return result
    })
  }

  // ── 读路径：一律读穿 ──

  override async loadSession(...args: Parameters<InMemorySessionStore['loadSession']>): ReturnType<InMemorySessionStore['loadSession']> {
    return this.readThrough(() => super.loadSession(...args))
  }

  override async loadRecords(...args: Parameters<InMemorySessionStore['loadRecords']>): ReturnType<InMemorySessionStore['loadRecords']> {
    return this.readThrough(() => super.loadRecords(...args))
  }

  override async loadHistory(...args: Parameters<InMemorySessionStore['loadHistory']>): ReturnType<InMemorySessionStore['loadHistory']> {
    return this.readThrough(() => super.loadHistory(...args))
  }

  override async loadContext(...args: Parameters<InMemorySessionStore['loadContext']>): ReturnType<InMemorySessionStore['loadContext']> {
    return this.readThrough(() => super.loadContext(...args))
  }

  override async loadTodos(...args: Parameters<InMemorySessionStore['loadTodos']>): ReturnType<InMemorySessionStore['loadTodos']> {
    return this.readThrough(() => super.loadTodos(...args))
  }

  override async queryOperation(...args: Parameters<InMemorySessionStore['queryOperation']>): ReturnType<InMemorySessionStore['queryOperation']> {
    return this.readThrough(() => super.queryOperation(...args))
  }

  // ── 写路径：统一事务（reload → 快照 → super → flush；失败回滚）──

  override async commit(sessionId: string, prepared: PreparedOperation, opts?: CommitEntryOpts): ReturnType<InMemorySessionStore['commit']> {
    return this.transaction(() => super.commit(sessionId, prepared, opts))
  }

  override async saveTodos(sessionId: string, prepared: PreparedOperation, opts?: CommitEntryOpts): ReturnType<InMemorySessionStore['saveTodos']> {
    return this.transaction(() => super.saveTodos(sessionId, prepared, opts))
  }

  override async deleteSession(sessionId: string, prepared: PreparedOperation, opts?: CommitEntryOpts): ReturnType<InMemorySessionStore['deleteSession']> {
    return this.transaction(() => super.deleteSession(sessionId, prepared, opts))
  }

  // ── 授权：锁内加载 → 修改 → 可靠持久化（评审 R6；错误传播，不吞）──
  // 返回 Promise<void> 与基类 void 签名兼容；调用方应 await（FileSessionStore 类型下可见）。

  override async refreshAuthorization(auth: AuthorizationContext): Promise<void> {
    await this.transaction(() => {
      super.refreshAuthorization(auth)
      return Promise.resolve()
    })
  }

  override async expireAuthorization(): Promise<void> {
    await this.transaction(() => {
      super.expireAuthorization()
      return Promise.resolve()
    })
  }
}
/**
 * Pluggable session storage (issue #4).
 *
 * SessionStorage is the storage seam: hosts implement load/save (required)
 * plus delete/list (optional) to back transcripts with SQLite/Postgres/remote
 * KV. Domain transforms (fork/revert/compact) stay SDK-side — backends are
 * storage adapters, not conversation-semantic adapters.
 *
 * Spec: docs/superpowers/specs/2026-09-22-pluggable-session-storage-design.md
 */

import { readFile, writeFile, mkdir, readdir, rename, unlink, rm } from 'fs/promises'
import { join } from 'path'
import type { NormalizedMessageParam } from './providers/types.js'
import type { SessionData, SessionMetadata } from './session.js'
import { TODO_PRIORITIES, TODO_STATUSES, type TodoInfo, type TodoStatus, type TodoPriority } from './types.js'

function isNodeError(e: unknown): e is NodeJS.ErrnoException {
  return e instanceof Error && 'code' in e
}

const SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/

/**
 * File backend sessionId guard (issue #128): the sessions directory is built
 * by `join(baseDir, sessionId)` — reject anything that could traverse out of
 * it. Covers direct storage calls, SessionManager and legacy wrappers alike.
 */
function assertSafeSessionId(sessionId: string): void {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error(`Invalid sessionId: ${sessionId}. Must match /^[a-zA-Z0-9_-]+$/`)
  }
}

/** Storage adapter for session transcripts. Load/save are the only true primitives. */
export interface SessionStorage {
  /** null = session does not exist; throw = storage failure. */
  load(sessionId: string): Promise<SessionData | null>
  /**
   * throw = write failure. metadata is fully normalized by the SDK.
   *
   * create-only contract (issue #128 review P2, spec §6.4): `expectedRevision:
   * null` means "the TRANSCRIPT does not exist" — judged by `load()` returning
   * null, NOT by session row/dir existence. SQL adapters: check
   * `transcript_revision IS NULL`; a prior `saveTodos()` creating the session
   * row must not reject the first transcript checkpoint.
   */
  save(
    sessionId: string,
    messages: NormalizedMessageParam[],
    metadata: SessionMetadata,
    opts?: SaveOptions,
  ): Promise<void>
  /**
   * Session-scoped todos sidecar (issue #128). Required — custom backends must
   * implement it (TS compile-time enforcement; Agent construction additionally
   * validates at runtime for JS consumers).
   * - [] = nothing saved yet
   * - SessionDataInvalidError = unparseable/malformed stored data
   * - other throws = storage failure (propagated with cause)
   */
  loadTodos(sessionId: string): Promise<TodoInfo[]>
  /** Full-list last-write-wins rewrite. Never touches the transcript or its revision. */
  saveTodos(sessionId: string, todos: TodoInfo[]): Promise<void>
  /**
   * Delete a session. SDK wrappers throw "not implemented" when absent.
   * Dual-purge contract (issue #128 review P2): must remove BOTH the
   * transcript and its todos sidecar in one operation.
   */
  delete?(sessionId: string): Promise<boolean>
  /** Enumerate session metadata. SDK wrappers throw "not implemented" when absent. */
  list?(): Promise<SessionMetadata[]>
}

export interface SaveOptions {
  /**
   * 三态（spec §5）：
   * - 省略：legacy upsert——无条件覆盖，不启用并发守卫，写入数据不含 revision
   * - null：create-only——**transcript 必须不存在**（`load()` 返回 null；与
   *   session 行/目录是否存在无关），否则抛 SessionConflictError。SQL adapter
   *   以 `transcript_revision IS NULL` 判定——先前 saveTodos() 建的行不得导致
   *   首次 checkpoint 假冲突（issue #128 review P2）
   * - 数字：CAS——必须等于存储中的当前 revision，否则抛 SessionConflictError
   */
  expectedRevision?: number | null
}

/** How SDK-side read-modify-write cores guard their saves (spec §8). */
export type ConcurrencyGuard = 'none' | 'source-revision'

/** 乐观并发冲突：expectedRevision 与存储当前值不匹配，或 create-only 撞已有会话。 */
export class SessionConflictError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly expectedRevision: number | null,
    public readonly actualRevision?: number,
  ) {
    super(
      `Session conflict on ${sessionId}: expected ${
        expectedRevision === null ? 'no existing session (create-only)' : `revision ${expectedRevision}`
      }${actualRevision === undefined ? '' : `, found revision ${actualRevision}`}`,
    )
    this.name = 'SessionConflictError'
  }
}

/** strict 模式下 resume 的会话不存在。 */
export class SessionNotFoundError extends Error {
  constructor(public readonly sessionId: string) {
    super(`Session not found: ${sessionId}`)
    this.name = 'SessionNotFoundError'
  }
}

/** load 返回的数据未通过形状校验。 */
export class SessionDataInvalidError extends Error {
  constructor(public readonly sessionId: string, reason: string) {
    super(`Invalid session data for ${sessionId}: ${reason}`)
    this.name = 'SessionDataInvalidError'
  }
}

/** Ensure every message has a stable id. */
function ensureMessageIds(messages: NormalizedMessageParam[]): NormalizedMessageParam[] {
  for (const msg of messages) {
    if (!msg.id) msg.id = crypto.randomUUID()
  }
  return messages
}

/**
 * Fill defaults — field order MUST stay identical to the legacy saveSession
 * literal so legacy-path JSON stays byte-compatible (undefined keys are
 * dropped by JSON.stringify).
 */
function normalizeMetadata(
  sessionId: string,
  messages: NormalizedMessageParam[],
  partial: Partial<SessionMetadata>,
  expectedRevision?: number | null,
): SessionMetadata {
  return {
    id: sessionId,
    cwd: partial.cwd || process.cwd(),
    model: partial.model || 'claude-sonnet-4-6',
    provider: partial.provider,
    createdAt: partial.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messageCount: messages.length,
    summary: partial.summary,
    lastInputTokens: partial.lastInputTokens,
    lastOutputTokens: partial.lastOutputTokens,
    activatedTools: partial.activatedTools,
    tag: partial.tag,
    // Tri-state (spec §5): omitted → no revision key (legacy byte-compat);
    // create-only (null) → 1; CAS number → expected + 1. partial.revision is
    // deliberately ignored — the guard is the only source of truth.
    revision: expectedRevision === undefined ? undefined : (expectedRevision ?? 0) + 1,
  }
}

/**
 * Normalized save: ensureMessageIds → normalizeMetadata → storage.save.
 * INTERNAL — never export from src/index.ts (spec §12: a public escape hatch
 * would let hosts bypass CAS and clobber revision state).
 */
export async function saveSessionTo(
  storage: SessionStorage,
  sessionId: string,
  messages: NormalizedMessageParam[],
  partial: Partial<SessionMetadata>,
  opts?: SaveOptions,
): Promise<void> {
  const messagesWithIds = ensureMessageIds(messages)
  const metadata = normalizeMetadata(sessionId, messagesWithIds, partial, opts?.expectedRevision)
  await storage.save(sessionId, messagesWithIds, metadata, opts)
}

/**
 * Validated load: storage.load → shape validation → defensive ensureMessageIds.
 * INTERNAL — never export from src/index.ts.
 */
export async function loadSessionFrom(
  storage: SessionStorage,
  sessionId: string,
): Promise<SessionData | null> {
  const data = await storage.load(sessionId)
  if (!data) return null
  if (typeof data !== 'object' || typeof data.metadata !== 'object' || data.metadata === null
    || !Array.isArray(data.messages)) {
    throw new SessionDataInvalidError(sessionId, 'malformed SessionData: metadata object and messages array required')
  }
  if (data.metadata.id !== sessionId) {
    throw new SessionDataInvalidError(sessionId, `metadata.id mismatch: stored ${String(data.metadata.id)}`)
  }
  data.messages = ensureMessageIds(data.messages)
  return data
}

/** Default JSON-file backend. Lazy $HOME resolution keeps HOME-isolated tests working. */
export class FileSessionStorage implements SessionStorage {
  private readonly explicitBaseDir?: string

  constructor(opts?: { baseDir?: string }) {
    this.explicitBaseDir = opts?.baseDir
  }

  /** Per-call env read — do NOT resolve in the constructor. */
  private baseDir(): string {
    if (this.explicitBaseDir) return this.explicitBaseDir
    const home = process.env.HOME || process.env.USERPROFILE || '/tmp'
    return join(home, '.agents', 'sessions')
  }

  private sessionPath(sessionId: string): string {
    return join(this.baseDir(), sessionId)
  }

  async load(sessionId: string): Promise<SessionData | null> {
    try {
      const content = await readFile(join(this.sessionPath(sessionId), 'transcript.json'), 'utf-8')
      const data = JSON.parse(content) as SessionData
      data.messages = ensureMessageIds(data.messages)
      return data
    } catch {
      return null
    }
  }

  async save(sessionId: string, messages: NormalizedMessageParam[], metadata: SessionMetadata, opts?: SaveOptions): Promise<void> {
    // Best-effort CAS (spec §6): read-check-write has a cross-process race
    // window; single-process sequential operations are correct. True CAS
    // belongs to transactional backends (SQLite/Postgres in-transaction).
    if (opts?.expectedRevision !== undefined) {
      const existing = await this.load(sessionId)
      if (opts.expectedRevision === null) {
        if (existing) {
          throw new SessionConflictError(sessionId, null, existing.metadata.revision ?? 0)
        }
      } else {
        if (!existing) {
          throw new SessionConflictError(sessionId, opts.expectedRevision, undefined)
        }
        const actual = existing.metadata.revision ?? 0
        if (actual !== opts.expectedRevision) {
          throw new SessionConflictError(sessionId, opts.expectedRevision, actual)
        }
      }
    }

    const dir = this.sessionPath(sessionId)
    await mkdir(dir, { recursive: true })

    // Atomic replacement (review #47 P1): tmp + rename. A crash mid-write can
    // never leave the existing transcript truncated.
    const finalPath = join(dir, 'transcript.json')
    const tmpPath = join(dir, `transcript.json.tmp-${crypto.randomUUID()}`)
    try {
      await writeFile(tmpPath, JSON.stringify({ metadata, messages }, null, 2), 'utf-8')
      await rename(tmpPath, finalPath)
    } catch (err) {
      await unlink(tmpPath).catch(() => {})
      throw err
    }
  }

  async delete(sessionId: string): Promise<boolean> {
    try {
      await rm(this.sessionPath(sessionId), { recursive: true, force: true })
      return true
    } catch {
      return false
    }
  }

  async list(): Promise<SessionMetadata[]> {
    try {
      const entries = await readdir(this.baseDir())
      const sessions: SessionMetadata[] = []
      for (const entry of entries) {
        try {
          const data = await this.load(entry)
          if (data?.metadata) sessions.push(data.metadata)
        } catch {
          // Skip invalid sessions
        }
      }
      sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      return sessions
    } catch {
      return []
    }
  }

  async loadTodos(sessionId: string): Promise<TodoInfo[]> {
    assertSafeSessionId(sessionId)
    let content: string
    try {
      content = await readFile(join(this.sessionPath(sessionId), 'todos.json'), 'utf-8')
    } catch (err) {
      // Missing file = nothing saved yet; any other IO failure propagates with
      // its cause — corruption/IO is never disguised as an empty list (spec §5).
      if (isNodeError(err) && err.code === 'ENOENT') return []
      throw err
    }
    try {
      const data = JSON.parse(content) as { todos?: unknown }
      if (!Array.isArray(data.todos)) {
        throw new SessionDataInvalidError(sessionId, 'todos.json: todos must be an array')
      }
      for (const t of data.todos as Array<Partial<TodoInfo>>) {
        if (
          !t || typeof t.content !== 'string' ||
          !TODO_STATUSES.includes(t.status as TodoStatus) ||
          !TODO_PRIORITIES.includes(t.priority as TodoPriority)
        ) {
          throw new SessionDataInvalidError(sessionId, 'todos.json: invalid todo entry')
        }
      }
      return data.todos as TodoInfo[]
    } catch (err) {
      if (err instanceof SessionDataInvalidError) throw err
      throw new SessionDataInvalidError(sessionId, `todos.json is not valid JSON: ${String(err)}`)
    }
  }

  async saveTodos(sessionId: string, todos: TodoInfo[]): Promise<void> {
    assertSafeSessionId(sessionId)
    const dir = this.sessionPath(sessionId)
    await mkdir(dir, { recursive: true })
    // Atomic replacement — same pattern as the transcript save above.
    const finalPath = join(dir, 'todos.json')
    const tmpPath = join(dir, `todos.json.tmp-${crypto.randomUUID()}`)
    try {
      await writeFile(tmpPath, JSON.stringify({ updatedAt: new Date().toISOString(), todos }, null, 2), 'utf-8')
      await rename(tmpPath, finalPath)
    } catch (err) {
      await unlink(tmpPath).catch(() => {})
      throw err
    }
  }
}

export const defaultSessionStorage: SessionStorage = new FileSessionStorage()

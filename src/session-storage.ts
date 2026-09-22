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

/** Storage adapter for session transcripts. Load/save are the only true primitives. */
export interface SessionStorage {
  /** null = session does not exist; throw = storage failure. */
  load(sessionId: string): Promise<SessionData | null>
  /** throw = write failure. metadata is fully normalized by the SDK. */
  save(
    sessionId: string,
    messages: NormalizedMessageParam[],
    metadata: SessionMetadata,
  ): Promise<void>
  /** Delete a session. SDK wrappers throw "not implemented" when absent. */
  delete?(sessionId: string): Promise<boolean>
  /** Enumerate session metadata. SDK wrappers throw "not implemented" when absent. */
  list?(): Promise<SessionMetadata[]>
}

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
    revision: partial.revision,
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
): Promise<void> {
  const messagesWithIds = ensureMessageIds(messages)
  const metadata = normalizeMetadata(sessionId, messagesWithIds, partial)
  await storage.save(sessionId, messagesWithIds, metadata)
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

  async save(sessionId: string, messages: NormalizedMessageParam[], metadata: SessionMetadata): Promise<void> {
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
}

export const defaultSessionStorage: SessionStorage = new FileSessionStorage()

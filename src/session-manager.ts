/**
 * Storage-bound session operations facade (issue #4).
 *
 * One injection, no way to miss-pass: hosts that use a custom backend get
 * fork/revert/compact/etc. on the SAME storage the Agent writes to. Legacy
 * module-level functions stay bound to the default file backend.
 */
import type { NormalizedMessageParam } from './providers/types.js'
import { appendToSessionWith, forkSessionWith, renameSessionWith, tagSessionWith } from './session.js'
import type { ForkOptions, ForkSource, SessionData, SessionMetadata } from './session.js'
import { loadSessionFrom, type SessionStorage } from './session-storage.js'
import { revertSessionWith } from './session-revert.js'
import { compactSessionStreamWith } from './compact-session.js'
import type { RevertResult, RevertSessionOptions } from './session-revert.js'
import type { SDKCompactMessage, TodoInfo } from './types.js'
import type { CompactSessionOptions, CompactSessionResult } from './compact-session.js'

export interface SessionManager {
  fork(source: ForkSource | string, newSessionId?: string, options?: ForkOptions): Promise<string | null>
  get(sessionId: string): Promise<SessionData | null>
  getMessages(sessionId: string): Promise<NormalizedMessageParam[]>
  delete(sessionId: string): Promise<boolean>
  list(): Promise<SessionMetadata[]>
  revert(sessionId: string, messageId: string, opts?: RevertSessionOptions): Promise<RevertResult>
  compactStream(opts: CompactSessionOptions): AsyncGenerator<SDKCompactMessage, CompactSessionResult>
  compact(opts: CompactSessionOptions): Promise<CompactSessionResult>
  append(sessionId: string, message: NormalizedMessageParam): Promise<void>
  rename(sessionId: string, title: string): Promise<void>
  tag(sessionId: string, tag: string | null): Promise<void>
  /** Session-scoped todos via the bound storage (issue #128). */
  getTodos(sessionId: string): Promise<TodoInfo[]>
  /** Clear todos via the bound storage (equivalent to saveTodos(sessionId, [])). */
  clearTodos(sessionId: string): Promise<void>
}

export function createSessionManager(init: { storage: SessionStorage }): SessionManager {
  const { storage } = init
  return {
    async fork(source, newSessionId, options) {
      // create-only target (spec §8): source snapshot semantics; a racing fork
      // to the same newSessionId gets SessionConflictError.
      return forkSessionWith(storage, source, newSessionId, options, { expectedRevision: null })
    },
    async get(sessionId) {
      return loadSessionFrom(storage, sessionId)
    },
    async getMessages(sessionId) {
      const data = await loadSessionFrom(storage, sessionId)
      return data?.messages ?? []
    },
    async delete(sessionId) {
      if (!storage.delete) throw new Error('SessionStorage.delete not implemented by backend')
      return storage.delete(sessionId)
    },
    async list() {
      if (!storage.list) throw new Error('SessionStorage.list not implemented by backend')
      return storage.list()
    },
    async revert(sessionId, messageId, opts) {
      return revertSessionWith(storage, sessionId, messageId, opts, 'source-revision')
    },
    compactStream(opts) {
      return compactSessionStreamWith(storage, opts, 'source-revision')
    },
    async compact(opts) {
      const stream = compactSessionStreamWith(storage, opts, 'source-revision')
      while (true) {
        const next = await stream.next()
        if (next.done) return next.value
      }
    },
    async append(sessionId, message) {
      return appendToSessionWith(storage, sessionId, message, 'source-revision')
    },
    async rename(sessionId, title) {
      return renameSessionWith(storage, sessionId, title, 'source-revision')
    },
    async tag(sessionId, tag) {
      return tagSessionWith(storage, sessionId, tag, 'source-revision')
    },
    async getTodos(sessionId) {
      return storage.loadTodos(sessionId)
    },
    async clearTodos(sessionId) {
      return storage.saveTodos(sessionId, [])
    },
  }
}

/**
 * Storage-bound session operations facade (issue #4).
 *
 * One injection, no way to miss-pass: hosts that use a custom backend get
 * fork/revert/compact/etc. on the SAME storage the Agent writes to. Legacy
 * module-level functions stay bound to the default file backend.
 */
import type { NormalizedMessageParam } from './providers/types.js'
import { forkSessionWith } from './session.js'
import type { ForkOptions, ForkSource, SessionData, SessionMetadata } from './session.js'
import { loadSessionFrom, saveSessionTo, type SessionStorage } from './session-storage.js'
import { revertSessionWith } from './session-revert.js'
import { compactSessionStreamWith } from './compact-session.js'
import type { RevertResult, RevertSessionOptions } from './session-revert.js'
import type { SDKCompactMessage } from './types.js'
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
      const data = await loadSessionFrom(storage, sessionId)
      if (!data) return
      const messages = [...data.messages, message.id ? message : { ...message, id: crypto.randomUUID() }]
      await saveSessionTo(storage, sessionId, messages, data.metadata,
        { expectedRevision: data.metadata.revision ?? 0 })
    },
    async rename(sessionId, title) {
      const data = await loadSessionFrom(storage, sessionId)
      if (!data) return
      await saveSessionTo(storage, sessionId, data.messages, { ...data.metadata, summary: title },
        { expectedRevision: data.metadata.revision ?? 0 })
    },
    async tag(sessionId, tag) {
      const data = await loadSessionFrom(storage, sessionId)
      if (!data) return
      await saveSessionTo(storage, sessionId, data.messages, { ...data.metadata, tag },
        { expectedRevision: data.metadata.revision ?? 0 })
    },
  }
}

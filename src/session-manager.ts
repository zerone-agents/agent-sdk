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
import { loadSessionFrom, type SessionStorage } from './session-storage.js'

export interface SessionManager {
  fork(source: ForkSource | string, newSessionId?: string, options?: ForkOptions): Promise<string | null>
  get(sessionId: string): Promise<SessionData | null>
  getMessages(sessionId: string): Promise<NormalizedMessageParam[]>
  delete(sessionId: string): Promise<boolean>
  list(): Promise<SessionMetadata[]>
  // revert / compactStream / compact / append / rename / tag — added in Task 4
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
  } as SessionManager
}

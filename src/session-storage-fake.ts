/**
 * In-memory SessionStorage with REAL revision CAS semantics — test helper
 * for issue #4 (simulates what a transactional SQL backend does).
 * NOT exported from src/index.ts.
 */
import type { NormalizedMessageParam } from './providers/types.js'
import type { SessionData, SessionMetadata } from './session.js'
import { SessionConflictError, type SaveOptions, type SessionStorage } from './session-storage.js'

export class InMemorySessionStorage implements SessionStorage {
  readonly store = new Map<string, SessionData>()
  readonly saveCalls: Array<{ sessionId: string; metadata: SessionMetadata; opts?: SaveOptions }> = []
  readonly loadCalls: string[] = []
  /** When true, every save rejects (error-semantics tests). */
  failSaves = false

  async load(sessionId: string): Promise<SessionData | null> {
    this.loadCalls.push(sessionId)
    const data = this.store.get(sessionId)
    return data ? structuredClone(data) : null
  }

  async save(
    sessionId: string,
    messages: NormalizedMessageParam[],
    metadata: SessionMetadata,
    opts?: SaveOptions,
  ): Promise<void> {
    if (this.failSaves) throw new Error('injected save failure')
    this.saveCalls.push({ sessionId, metadata: structuredClone(metadata), opts })
    const existing = this.store.get(sessionId)
    if (opts?.expectedRevision !== undefined) {
      if (opts.expectedRevision === null && existing) {
        throw new SessionConflictError(sessionId, null, existing.metadata.revision ?? 0)
      }
      if (opts.expectedRevision !== null) {
        if (!existing || (existing.metadata.revision ?? 0) !== opts.expectedRevision) {
          throw new SessionConflictError(sessionId, opts.expectedRevision, existing?.metadata.revision ?? 0)
        }
      }
    }
    this.store.set(sessionId, structuredClone({ metadata, messages }))
  }

  async delete(sessionId: string): Promise<boolean> {
    return this.store.delete(sessionId)
  }

  async list(): Promise<SessionMetadata[]> {
    return [...this.store.values()]
      .map((d) => structuredClone(d.metadata))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }
}

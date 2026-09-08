import type { DiagnosticsSink } from '../utils/diagnostics.js'
import type { MemoryEventSink } from './events.js'
import {
  MemoryAccessError,
  MemoryNotFoundError,
  MemoryServiceUnavailableError,
  MemoryValidationError,
  type MemoryServicePhase,
} from './errors.js'
import type { MemoryContentPolicy } from './policy.js'
import type { MemoryStorage } from './storage.js'
import type {
  MemoryAccessPolicy,
  MemoryAdministration,
  MemoryAuditEvent,
  MemoryAuditQuery,
  MemoryBudgets,
  MemoryInvocationContext,
  MemoryMutationResult,
  MemoryRecord,
  MemoryRecordQuery,
  MemoryScope,
  MemorySearchQuery,
  MemorySession,
  MemorySessionCreateInput,
  MemoryService,
  MemoryWorkspace,
} from './types.js'
import { defaultMemoryWorkspaceResolver, type MemoryWorkspaceResolver } from './workspace.js'

export type { MemoryServicePhase } from './errors.js'

export interface MemoryServiceOptions {
  storage: MemoryStorage
  budgets?: Partial<MemoryBudgets>
  policy?: MemoryContentPolicy
  resolveWorkspace?: MemoryWorkspaceResolver
  events?: MemoryEventSink
  diagnostics?: DiagnosticsSink          // from ../utils/diagnostics.js
  now?: () => Date                       // test seam; default () => new Date()
  newId?: () => string                   // test seam; default crypto.randomUUID
}

/** Session internal shape: everything a method needs to enforce isolation. */
interface BoundSession {
  context: MemoryInvocationContext
  policy: MemoryAccessPolicy | undefined
  boundWorkspace: MemoryWorkspace | null
}

function canReadWorkspace(session: BoundSession, workspaceId: string | null): boolean {
  return workspaceId === null || session.boundWorkspace?.id === workspaceId
}

function assertWritable(session: BoundSession, scope: MemoryScope): void {
  if (scope === 'workspace' && !session.boundWorkspace) {
    throw new MemoryAccessError('No workspace is bound to this memory session; workspace memory is unavailable.')
  }
  if (session.policy?.writableScopes && !session.policy.writableScopes.includes(scope)) {
    throw new MemoryAccessError(`Writes to the "${scope}" scope are not permitted for this memory session.`)
  }
}

/** Loads the record and enforces session visibility (guessed-ID defense). */
async function loadAccessibleRecord(session: BoundSession, recordId: string, storage: MemoryStorage): Promise<MemoryRecord> {
  const record = await storage.getRecord(recordId)
  if (!record) throw new MemoryNotFoundError(recordId)
  if (!canReadWorkspace(session, record.workspaceId)) {
    throw new MemoryAccessError(`Memory record ${recordId} is outside this session's workspace binding.`)
  }
  return record
}

/** Task 8 replaces the mutation stubs; the code is reserved so call sites stay stable. */
function unimplementedMutation(): MemoryValidationError {
  return new MemoryValidationError([
    { code: 'unimplemented', severity: 'error', message: 'mutation lands in Task 8' },
  ])
}

export function createMemoryService(options: MemoryServiceOptions): MemoryService {
  let phase: MemoryServicePhase = 'stopped'
  let lifecycleChain: Promise<void> = Promise.resolve()
  // ONE admission queue for ALL persistent work (review P1-4): domain
  // mutations AND bind workspace registrations. "Admitted" = enqueued; a stop()
  // draining this chain therefore always covers in-flight bind registrations.
  let admissionChain: Promise<unknown> = Promise.resolve()

  function assertRunning(method: string): void {
    if (phase !== 'running') throw new MemoryServiceUnavailableError(method, phase)
  }

  function admit<T>(fn: () => Promise<T>): Promise<T> {
    const result = admissionChain.then(fn)
    admissionChain = result.then(() => undefined, () => undefined)
    return result
  }

  // ROUND-5 REVIEW (R5-P2): Service-layer diagnostics must NEVER block a write.
  // A host sink that throws must not reject a legitimate mutation (e.g. one
  // that produced only a policy WARNING — "warnings never block") nor alter
  // post-commit behavior. Same contract as the adapter's safeWarn/safeError
  // (R4-P1). Raw errors travel via the cause channel, never interpolated.
  const safeWarn = (msg: string, fields?: Record<string, unknown>, cause?: unknown): void => {
    try {
      options.diagnostics?.warn(msg, fields, cause)
    } catch {
      // diagnostics must never affect service behavior (R5-P2)
    }
  }
  const safeError = (msg: string, fields?: Record<string, unknown>, cause?: unknown): void => {
    try {
      options.diagnostics?.error(msg, fields, cause)
    } catch {
      // diagnostics must never affect service behavior (R5-P2)
    }
  }

  /** Serialize start bodies; concurrent same-transition calls share one promise. */
  function start(): Promise<void> {
    const run = lifecycleChain.then(async () => {
      // Entry guard (fix round 2, #61): only a true 'stopped' service may run
      // the start body. 'starting'/'running' early-return like before, and a
      // 'stopping' intent published SYNCHRONOUSLY (stop()) while this body was
      // still queued must not be overwritten — running open() here would flip
      // the phase back to 'running' after the stop drain, silently admitting
      // ops on closed storage.
      if (phase !== 'stopped') return
      phase = 'starting'
      try {
        await options.storage.open()
        // Conditional completion (fix round 1, #61): stop() may have published
        // 'stopping' SYNCHRONOUSLY while open() was in-flight; do not override
        // that intent back to 'running'. Unconditional assignment would open a
        // window where new ops pass assertRunning and escape the stop drain
        // (they would run after storage.close() or, worse, silently succeed).
        if (phase === 'starting') phase = 'running'
      } catch (err) {
        phase = 'stopped'
        throw err
      }
    })
    // Tail swallows the body's rejection (fix round 2, #61): the caller still
    // observes it via `run`, but the chain itself must stay alive — a rejected
    // chain would poison every later start()/stop() with the stale error and
    // leave a floating rejected promise (unhandledRejection). Phase reset to
    // 'stopped' is preserved so a restart is reachable.
    lifecycleChain = run.then(() => undefined, () => { phase = 'stopped' })
    return run
  }

  /**
   * stop() publishes 'stopping' SYNCHRONOUSLY at call time (before any await),
   * so operations invoked after stop() reject immediately; the drain/close
   * body then runs serialized on the lifecycle chain. It DRAINS the admission
   * chain (domain mutations + in-flight bind registrations, review P1-4)
   * before closing storage — every operation admitted before the intent
   * publication completes before the storage closes.
   */
  function stop(): Promise<void> {
    // No 'stopped' early return (fix round 2, #61): a start() whose body is
    // still QUEUED leaves phase reading 'stopped' at this call point — an
    // early return would silently swallow the stop intent (no sync
    // publication, no drain, no close) and the queued start body would then
    // carry the service to 'running'. Unconditional publication is also
    // idempotent for a genuinely idle service: the body drains an empty
    // chain, closes (storage close must be idempotent) and lands back on
    // 'stopped'.
    if (phase === 'stopping') return lifecycleChain // share the in-flight stop
    phase = 'stopping' // synchronous intent publication
    const run = lifecycleChain.then(async () => {
      try {
        await admissionChain // drain ALL admitted operations (new ones are impossible: phase already 'stopping')
        await options.storage.close()
        // Conditional completion (fix round 1, #61): mirror the start branch —
        // never overwrite a phase that a newer transition intent already owns.
        if (phase === 'stopping') phase = 'stopped'
      } catch (err) {
        if (phase === 'stopping') phase = 'stopped'
        throw err
      }
    })
    // Tail swallows the body's rejection (fix round 2, #61): mirror the start
    // branch — a close() failure must not poison the chain for later start()s.
    // Caller still observes the rejection via `run`; phase reset preserved.
    lifecycleChain = run.then(() => undefined, () => { phase = 'stopped' })
    return run
  }

  /**
   * bind(): assertRunning, then the ENTIRE rest (workspace resolution,
   * registration, session construction) runs inside admit(...) (review P1-4):
   * the registration is admitted at enqueue time, so stop() draining the
   * admission chain always finishes it before closing storage.
   */
  // async entry: assertRunning's sync throw becomes a REJECTED promise, never
  // a synchronous escape (callers use expect(promise).rejects).
  async function bind(context: MemoryInvocationContext, policy?: MemoryAccessPolicy): Promise<MemorySession> {
    assertRunning('bind')
    return admit(async () => {
      let boundWorkspace: MemoryWorkspace | null = null
      if (context.workspace && context.workspace.length > 0) {
        const resolver = options.resolveWorkspace ?? defaultMemoryWorkspaceResolver
        boundWorkspace = await resolver(context.workspace)
        await options.storage.ensureWorkspace(boundWorkspace)
      }
      return makeSession({ context, policy, boundWorkspace })
    })
  }

  function makeSession(session: BoundSession): MemorySession {
    return {
      async add(input: MemorySessionCreateInput): Promise<MemoryMutationResult> {
        assertRunning('add')
        return admit(async () => {
          assertWritable(session, input.scope)
          throw unimplementedMutation()
        })
      },

      async search(_query: MemorySearchQuery): Promise<MemoryRecord[]> {
        assertRunning('search')
        return [] // Task 8: scope-band search with access isolation + ranking
      },

      async replace(_recordId: string, _expectedRevision: number, _changes: unknown): Promise<MemoryMutationResult> {
        assertRunning('replace')
        return admit(async () => {
          // Task 8: loadAccessibleRecord(session, recordId) → assertWritable → conflict/state checks → commit
          throw unimplementedMutation()
        })
      },

      async remove(_recordId: string, _expectedRevision: number): Promise<MemoryMutationResult> {
        assertRunning('remove')
        return admit(async () => {
          throw unimplementedMutation()
        })
      },

      async renderContext(): Promise<string> {
        assertRunning('renderContext')
        return '' // Task 8: budgets-driven canonical rendering
      },
    }
  }

  const admin: MemoryAdministration = {
    async queryWorkspaces(): Promise<MemoryWorkspace[]> {
      assertRunning('queryWorkspaces')
      const workspaces: MemoryWorkspace[] = []
      for await (const ws of options.storage.scanWorkspaces()) workspaces.push(ws)
      workspaces.sort((a, b) => (a.canonicalPath < b.canonicalPath ? -1 : a.canonicalPath > b.canonicalPath ? 1 : 0))
      return workspaces
    },

    async queryRecords(_query: MemoryRecordQuery): Promise<MemoryRecord[]> {
      assertRunning('queryRecords')
      return [] // Task 8
    },

    async mutate(_command: unknown, _context: MemoryInvocationContext): Promise<MemoryMutationResult> {
      assertRunning('mutate')
      return admit(async () => {
        throw unimplementedMutation()
      })
    },

    async queryAudit(_query: MemoryAuditQuery): Promise<MemoryAuditEvent[]> {
      assertRunning('queryAudit')
      return [] // Task 9
    },
  }

  return { start, stop, bind, admin }
}

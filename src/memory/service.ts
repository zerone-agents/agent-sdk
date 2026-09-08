import { randomUUID } from 'node:crypto'

import type { DiagnosticsSink } from '../utils/diagnostics.js'
import type { MemoryEvent, MemoryEventSink } from './events.js'
import {
  MemoryAccessError,
  MemoryConflictError,
  MemoryNotFoundError,
  MemoryServiceUnavailableError,
  MemoryValidationError,
  type MemoryPolicyFinding,
  type MemoryServicePhase,
} from './errors.js'
import { countMemoryChars } from './length.js'
import { createDefaultMemoryContentPolicy, type MemoryContentPolicy } from './policy.js'
import { compareMemorySearchResults, matchMemoryRecord, normalizeMemoryText, resolveMemorySearchLimit, type MemorySearchMatch } from './search.js'
import { renderMemoryContext } from './render.js'
import type { MemoryStorage } from './storage.js'
import {
  DEFAULT_MEMORY_BUDGETS,
  MEMORY_IMPORTANCE_VALUES,
  type MemoryAccessPolicy,
  type MemoryAdministration,
  type MemoryAuditEvent,
  type MemoryAuditQuery,
  type MemoryBudgets,
  type MemoryImportance,
  type MemoryInvocationContext,
  type MemoryMutationCommand,
  type MemoryMutationResult,
  type MemoryOperation,
  type MemoryRecord,
  type MemoryRecordQuery,
  type MemoryReplaceChanges,
  type MemoryScope,
  type MemorySearchQuery,
  type MemorySession,
  type MemorySessionCreateInput,
  type MemoryService,
  type MemoryStatus,
  type MemoryWorkspace,
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

/** One atomic mutation: the primary effect plus everything storage.commit persists. */
interface MutationPlan {
  primary: MemoryRecord | null        // resulting primary record (null for purge)
  insertRecords: MemoryRecord[]
  replaceRecords: MemoryRecord[]
  deleteRecords: string[]
  /** Purge only: erase before/after content from EVERY prior audit event of these records. */
  redactAuditForRecords: string[]
  audit: MemoryAuditEvent[]           // built by the service (ids + timestamps)
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

  // Derived options: immutable for the service lifetime, so every admitted
  // mutation sees a consistent view (review P1-4 — no mid-chain option changes).
  const budgets: MemoryBudgets = { ...DEFAULT_MEMORY_BUDGETS, ...options.budgets }
  const policy: MemoryContentPolicy = options.policy ?? createDefaultMemoryContentPolicy()
  const now: () => Date = options.now ?? (() => new Date())
  const newId: () => string = options.newId ?? (() => randomUUID())

  /**
   * Audit events are built by the service: ids + timestamps, never by storage.
   * `reason` defaults to the invocation context's; a caller whose cause is
   * structural rather than contextual — the automatic capacity archive
   * (Task 9) — may override it per event.
   */
  function makeAuditEvent(
    context: MemoryInvocationContext,
    partial: Omit<MemoryAuditEvent, 'id' | 'committedAt' | 'actor' | 'sessionId' | 'sourceMessageId' | 'reason'> & { reason?: string },
  ): MemoryAuditEvent {
    return {
      ...partial,
      actor: context.actor,
      sessionId: context.sessionId,
      sourceMessageId: context.sourceMessageId,
      reason: partial.reason ?? context.reason,
      id: newId(),
      committedAt: now().toISOString(),
    }
  }

  /**
   * Structural validation (always, BEFORE policy): trim; empty → content.empty;
   * C0 control chars except \t\n\r plus DEL → content.control_chars; single
   * record exceeding its scope budget (weighted countMemoryChars) →
   * content.exceeds_budget. All findings aggregate into ONE MemoryValidationError.
   */
  function validateContent(content: string, scope: MemoryScope, workspaceId: string | null): string {
    const trimmed = content.trim()
    const findings: MemoryPolicyFinding[] = []
    if (trimmed.length === 0) {
      findings.push({ code: 'content.empty', severity: 'error', message: 'Content is empty after trimming.' })
    }
    // C0 controls except \t \n \r, plus DEL:
    if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(trimmed)) {
      findings.push({ code: 'content.control_chars', severity: 'error', message: 'Content contains NUL or control characters.' })
    }
    const size = countMemoryChars(trimmed) // weighted chars (review P2-5)
    const budget = scope === 'global' ? budgets.globalChars : scope === 'user' ? budgets.userChars : budgets.workspaceChars
    if (size > budget) {
      findings.push({ code: 'content.exceeds_budget', severity: 'error', message: `Content (${size} weighted chars) exceeds the ${scope} budget (${budget}).` })
    }
    if (findings.length > 0) throw new MemoryValidationError(findings)
    return trimmed
  }

  /**
   * Importance + exact-duplicate + host policy checks. The duplicate scan
   * covers active+archived in the same scope+workspaceId, excluding the record
   * being updated (`excludeRecordId`). Policy `error` findings join the
   * aggregate; `warning` findings go to safeWarn and NEVER block (R5-P2: even
   * a throwing diagnostics sink must not reject the write).
   */
  async function validateDuplicateAndPolicy(
    trimmed: string,
    scope: MemoryScope,
    workspaceId: string | null,
    importance: MemoryImportance,
    excludeRecordId?: string,
  ): Promise<void> {
    const findings: MemoryPolicyFinding[] = []
    if (!MEMORY_IMPORTANCE_VALUES.includes(importance)) {
      findings.push({ code: 'importance.invalid', severity: 'error', message: `Importance must be one of 25/50/75/100, got ${importance}.` })
    }
    for await (const r of options.storage.scanRecords({ scope, workspaceId, statuses: ['active', 'archived'] })) {
      if (r.id === excludeRecordId) continue
      if (r.content === trimmed) {
        findings.push({ code: 'duplicate.content', severity: 'error', message: `An identical record already exists (${r.id}).` })
        break
      }
    }
    const policyFindings = policy({ content: trimmed, scope })
    for (const w of policyFindings.filter((f) => f.severity === 'warning')) {
      // R5-P2: safeWarn — a throwing host sink must not turn a warning-only
      // finding into a rejected write ("warnings never block").
      safeWarn(`[memory] policy warning ${w.code}: ${w.message}`)
    }
    findings.push(...policyFindings.filter((f) => f.severity === 'error'))
    if (findings.length > 0) throw new MemoryValidationError(findings)
  }

  /** Illegal state-machine migration → transition.invalid (never silent no-op). */
  function invalidTransition(operation: MemoryOperation, status: MemoryStatus): MemoryValidationError {
    return new MemoryValidationError([
      { code: 'transition.invalid', severity: 'error', message: `Cannot ${operation} a "${status}" memory record.` },
    ])
  }

  /**
   * Post-commit event emission. Sinks are observational (per events.ts):
   * a throwing sink is reported via diagnostics and must NEVER turn a durable
   * commit into a reported failure, nor roll it back.
   */
  function emitEvent(event: MemoryEvent): void {
    if (!options.events) return
    try {
      options.events(event)
    } catch (err) {
      safeError('[memory] event sink threw after commit', { operation: 'MemoryEvent' }, err)
    }
  }

  /**
   * Task 10: session-visible search. Readable scopes = global + user + the
   * bound workspace (omitted when none is bound); statuses = active + archived
   * — deleted records are never readable, foreign workspaces never scanned.
   * Matching defers to the canonical pure functions (normalize both sides,
   * complete-match precedence, then all-terms); ranking and the hard `limit`
   * cap come from the same reviewed module. Empty (post-normalization) queries
   * short-circuit to [] — nothing matches nothing.
   */
  async function sessionSearch(session: BoundSession, query: MemorySearchQuery): Promise<MemoryRecord[]> {
    assertRunning('search')
    const limit = resolveMemorySearchLimit(query.limit)
    const normalizedQuery = normalizeMemoryText(query.text)
    if (normalizedQuery.length === 0) return []
    const matches: MemorySearchMatch[] = []
    const scopes: Array<{ scope: MemoryScope; workspaceId: string | null }> = [
      { scope: 'global', workspaceId: null },
      { scope: 'user', workspaceId: null },
      ...(session.boundWorkspace ? [{ scope: 'workspace' as const, workspaceId: session.boundWorkspace.id }] : []),
    ]
    for (const sel of scopes) {
      for await (const record of options.storage.scanRecords({
        scope: sel.scope, workspaceId: sel.workspaceId, statuses: ['active', 'archived'],
      })) {
        const kind = matchMemoryRecord(normalizeMemoryText(record.content), normalizedQuery)
        if (kind) matches.push({ record, kind })
      }
    }
    return matches.sort(compareMemorySearchResults).slice(0, limit).map((m) => m.record)
  }

  /**
   * Task 10: budgets-driven canonical rendering of the session's readable
   * memory — ACTIVE records only (archived/deleted never appear). The
   * workspace section is collected only when a workspace is bound (null →
   * canonical renderer omits it); selection/escaping live in render.ts.
   */
  async function sessionRenderContext(session: BoundSession): Promise<string> {
    assertRunning('renderContext')
    const collectActive = async (scope: MemoryScope, workspaceId: string | null): Promise<MemoryRecord[]> => {
      const out: MemoryRecord[] = []
      for await (const r of options.storage.scanRecords({ scope, workspaceId, statuses: ['active'] })) out.push(r)
      return out
    }
    return renderMemoryContext({
      global: await collectActive('global', null),
      user: await collectActive('user', null),
      workspace: session.boundWorkspace ? await collectActive('workspace', session.boundWorkspace.id) : null,
      budgets,
    })
  }

  /**
   * Task 9: budget-driven capacity enforcement (spec verbatim).
   * Rebuilds the ACTIVE set exactly as it will exist AFTER this mutation's
   * pending inserts/replaces (a restored record is active again, an updated
   * record carries its new content/importance). If the weighted total
   * (countMemoryChars — the SAME 口径 as validateContent and the budgets
   * themselves, review P2-5) exceeds the scope budget, archive candidates —
   * the PRIMARY record is never a candidate — ordered importance asc →
   * updatedAt asc → id asc until the total fits. Each archive bumps
   * revision+1 with updatedAt=now and pushes its 'capacity' audit event; all
   * of it lands in the SAME arrays the caller commits, so the primary
   * mutation, the automatic archives and every audit event are ONE
   * storage.commit(). Returns the archived records for the mutation result.
   */
  async function enforceCapacity(
    context: MemoryInvocationContext,
    scope: MemoryScope,
    workspaceId: string | null,
    primaryId: string,
    insertRecords: MemoryRecord[],
    replaceRecords: MemoryRecord[],
    audit: MemoryAuditEvent[],
  ): Promise<MemoryRecord[]> {
    const budget = scope === 'global' ? budgets.globalChars : scope === 'user' ? budgets.userChars : budgets.workspaceChars
    // Active set AFTER applying this mutation's pending inserts/replaces:
    const pending = new Map<string, MemoryRecord>()
    for (const r of insertRecords) pending.set(r.id, r)
    for (const r of replaceRecords) pending.set(r.id, r)
    const actives: MemoryRecord[] = []
    for await (const r of options.storage.scanRecords({ scope, workspaceId, statuses: ['active'] })) {
      actives.push(pending.get(r.id) ?? r)
    }
    for (const r of pending.values()) {
      if (r.status === 'active' && !actives.some((a) => a.id === r.id)) actives.push(r)
    }
    const total = () => actives.reduce((n, r) => n + countMemoryChars(r.content), 0) // weighted (P2-5)
    const archived: MemoryRecord[] = []
    const candidates = () => actives
      .filter((r) => r.id !== primaryId && !archived.some((a) => a.id === r.id))
      .sort((a, b) =>
        a.importance - b.importance ||
        (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    while (total() > budget) {
      const victim = candidates()[0]
      if (!victim) break // only the primary remains — validated against budget earlier
      const archivedRecord: MemoryRecord = {
        ...victim, status: 'archived', revision: victim.revision + 1, updatedAt: now().toISOString(),
      }
      archived.push(archivedRecord)
      replaceRecords.push(archivedRecord)
      audit.push(makeAuditEvent(context, {
        recordId: victim.id, scope, workspaceId, operation: 'archive',
        expectedRevision: victim.revision, committedRevision: archivedRecord.revision,
        beforeContent: victim.content, afterContent: victim.content,
        reason: 'capacity',
      }))
      actives.splice(actives.findIndex((a) => a.id === victim.id), 1)
    }
    return archived
  }

  /**
   * Task 9: global audit retention. Once this mutation's appends are known,
   * if the total event count exceeds `auditRetention`, the OLDEST events
   * (committedAt asc, id asc) beyond the cap are hard-deleted in the SAME
   * commit via deleteAuditIds. localeCompare on ISO-8601 UTC strings is
   * chronological; id tie-break keeps the order total (the brief's comparator
   * falls through to `1` for identical (committedAt, id), which is
   * inconsistent for self-comparison — same semantics, total order).
   */
  async function retentionDeletes(appended: number): Promise<string[]> {
    const all: MemoryAuditEvent[] = []
    for await (const e of options.storage.scanAudit({})) all.push(e)
    const overflow = all.length + appended - budgets.auditRetention
    if (overflow <= 0) return []
    return all
      .sort((a, b) => a.committedAt.localeCompare(b.committedAt) || a.id.localeCompare(b.id))
      .slice(0, overflow)
      .map((e) => e.id)
  }

  /**
   * The verbatim mutation pipeline (spec):
   * validate access&input → read & verify revision → calculate state change &
   * capacity → build ALL audit events → storage.commit() → return committed
   * result → emit MemoryEvent. Abort semantics live at the TOOL boundary
   * (MemoryTool.call), so no AbortSignal flows through here; once commit
   * resolves, the operation succeeds even if a signal fires later.
   *
   * The `plan` runs INSIDE the admission barrier: revision verification
   * happens against the serialized, current record immediately before the
   * commit is computed (spec), so cross-mutation conflicts are exact.
   *
   * Task 9: capacity enforcement runs for every plan whose primary stays
   * active (create, content update, importance update, restore — an
   * importance-only update leaves the weighted total unchanged and is a
   * natural no-op); retention pruning + purge redaction join the same commit.
   */
  async function runMutation(
    method: string,
    context: MemoryInvocationContext,
    plan: () => Promise<MutationPlan>,
  ): Promise<MemoryMutationResult> {
    // async entry: assertRunning's sync throw becomes a REJECTED promise, never
    // a synchronous escape (callers use expect(promise).rejects).
    assertRunning(method)
    const result = await admit(async () => {
      const p = await plan()
      // Capacity archives fold into the SAME commit as the primary mutation
      // (spec: primary mutation + automatic archives + audit = ONE commit).
      const archived: MemoryRecord[] = []
      if (p.primary && p.primary.status === 'active') {
        archived.push(...(await enforceCapacity(
          context, p.primary.scope, p.primary.workspaceId, p.primary.id,
          p.insertRecords, p.replaceRecords, p.audit,
        )))
      }
      const deleteAuditIds = await retentionDeletes(p.audit.length)
      await options.storage.commit({
        insertRecords: p.insertRecords,
        replaceRecords: p.replaceRecords,
        deleteRecords: p.deleteRecords,
        redactAuditForRecords: p.redactAuditForRecords,
        appendAudit: p.audit,
        deleteAuditIds,
      })
      return { record: p.primary, archived, audit: p.audit } satisfies MemoryMutationResult
    })
    emitEvent({ result, context }) // post-commit; sink failure → diagnostics, never rollback
    return result
  }

  /** Admin trusted load: no session checks; revision verified immediately before the commit. */
  async function loadCurrent(recordId: string, expectedRevision: number): Promise<MemoryRecord> {
    const record = await options.storage.getRecord(recordId)
    if (!record) throw new MemoryNotFoundError(recordId)
    if (expectedRevision !== record.revision) throw new MemoryConflictError(record)
    return record
  }

  /** Status transition shared by archive/restore/delete: revision+1, updatedAt bumped. */
  function applyTransition(
    record: MemoryRecord,
    context: MemoryInvocationContext,
    operation: MemoryOperation,
    nextStatus: MemoryStatus,
    extra: Partial<Pick<MemoryRecord, 'deletedAt'>> = {},
  ): { updated: MemoryRecord; audit: MemoryAuditEvent } {
    const timestamp = now()
    const updated: MemoryRecord = {
      ...record,
      ...extra,
      status: nextStatus,
      revision: record.revision + 1,
      updatedAt: timestamp.toISOString(),
    }
    const audit = makeAuditEvent(context, {
      recordId: record.id,
      scope: record.scope,
      workspaceId: record.workspaceId,
      operation,
      expectedRevision: record.revision,
      committedRevision: record.revision + 1,
      beforeContent: record.content,
      afterContent: record.content,
    })
    return { updated, audit }
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
      add(input: MemorySessionCreateInput): Promise<MemoryMutationResult> {
        return runMutation('add', session.context, async () => {
          assertWritable(session, input.scope)
          const workspaceId: string | null = input.scope === 'workspace' ? session.boundWorkspace!.id : null
          const content = validateContent(input.content, input.scope, workspaceId)
          await validateDuplicateAndPolicy(content, input.scope, workspaceId, input.importance)
          const timestamp = now()
          const record: MemoryRecord = {
            id: newId(),
            scope: input.scope,
            workspaceId,
            content,
            importance: input.importance,
            status: 'active',
            revision: 1,
            createdAt: timestamp.toISOString(),
            updatedAt: timestamp.toISOString(),
            deletedAt: null,
          }
          return {
            primary: record,
            insertRecords: [record],
            replaceRecords: [],
            deleteRecords: [],
            redactAuditForRecords: [],
            audit: [makeAuditEvent(session.context, {
              recordId: record.id,
              scope: record.scope,
              workspaceId: record.workspaceId,
              operation: 'create',
              expectedRevision: null,
              committedRevision: 1,
              beforeContent: null,
              afterContent: record.content,
            })],
          }
        })
      },

      search(query: MemorySearchQuery): Promise<MemoryRecord[]> {
        return sessionSearch(session, query)
      },

      replace(recordId: string, expectedRevision: number, changes: MemoryReplaceChanges): Promise<MemoryMutationResult> {
        return runMutation('replace', session.context, async () => {
          const record = await loadAccessibleRecord(session, recordId, options.storage)
          // R3-P2: replace/remove carry NO target scope — writability is checked
          // against the RECORD's own scope + this session's binding.
          assertWritable(session, record.scope)
          if (expectedRevision !== record.revision) throw new MemoryConflictError(record)
          if (record.status !== 'active' && record.status !== 'archived') {
            throw invalidTransition('update', record.status)
          }
          const content = changes.content !== undefined
            ? validateContent(changes.content, record.scope, record.workspaceId)
            : record.content
          const importance = changes.importance ?? record.importance
          await validateDuplicateAndPolicy(content, record.scope, record.workspaceId, importance, record.id)
          const timestamp = now()
          const updated: MemoryRecord = {
            ...record,
            content,
            importance,
            revision: record.revision + 1,
            updatedAt: timestamp.toISOString(),
          }
          return {
            primary: updated,
            insertRecords: [],
            replaceRecords: [updated],
            deleteRecords: [],
            redactAuditForRecords: [],
            audit: [makeAuditEvent(session.context, {
              recordId: record.id,
              scope: record.scope,
              workspaceId: record.workspaceId,
              operation: 'update',
              expectedRevision,
              committedRevision: record.revision + 1,
              beforeContent: record.content,
              afterContent: content,
            })],
          }
        })
      },

      remove(recordId: string, expectedRevision: number): Promise<MemoryMutationResult> {
        return runMutation('remove', session.context, async () => {
          const record = await loadAccessibleRecord(session, recordId, options.storage)
          // R3-P2: same as replace — writability follows the record's own scope.
          assertWritable(session, record.scope)
          if (expectedRevision !== record.revision) throw new MemoryConflictError(record)
          if (record.status !== 'active' && record.status !== 'archived') {
            throw invalidTransition('delete', record.status)
          }
          const timestamp = now()
          const updated: MemoryRecord = {
            ...record,
            status: 'deleted',
            deletedAt: timestamp.toISOString(),
            revision: record.revision + 1,
            updatedAt: timestamp.toISOString(),
          }
          return {
            primary: updated,
            insertRecords: [],
            replaceRecords: [updated],
            deleteRecords: [],
            redactAuditForRecords: [],
            audit: [makeAuditEvent(session.context, {
              recordId: record.id,
              scope: record.scope,
              workspaceId: record.workspaceId,
              operation: 'delete',
              expectedRevision,
              committedRevision: record.revision + 1,
              beforeContent: record.content,
              // Soft delete KEEPS content in the audit (task-8 ledger ①): the
              // record still exists — only its status changed — matching the
              // archive/restore "retain content" semantics; purge redacts it
              // later.
              afterContent: record.content,
            })],
          }
        })
      },

      renderContext(): Promise<string> {
        return sessionRenderContext(session)
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

    async queryRecords(query: MemoryRecordQuery): Promise<MemoryRecord[]> {
      assertRunning('queryRecords')
      const records: MemoryRecord[] = []
      for await (const record of options.storage.scanRecords({
        scope: query.scope,
        workspaceId: query.workspaceId,
        statuses: query.status !== undefined ? [query.status] : undefined,
      })) {
        records.push(record)
      }
      // Spec ordering: updatedAt desc, id asc (ISO strings compare chronologically).
      records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
      return records
    },

    /**
     * Admin mutations are TRUSTED: no session/access checks (the host owns the
     * store), but the same revision + state-machine rules apply. Creation rules
     * differ for scope↔workspaceId: a workspace-scoped record must carry an
     * explicit workspaceId, global/user must NOT (code `workspace.scope`).
     */
    mutate(command: MemoryMutationCommand, context: MemoryInvocationContext): Promise<MemoryMutationResult> {
      return runMutation('mutate', context, async () => {
        switch (command.type) {
          case 'create': {
            const { scope, content, importance } = command
            if (scope === 'workspace' && !command.workspaceId) {
              throw new MemoryValidationError([
                { code: 'workspace.scope', severity: 'error', message: 'A workspace-scoped memory record requires an explicit workspaceId.' },
              ])
            }
            if (scope !== 'workspace' && command.workspaceId) {
              throw new MemoryValidationError([
                { code: 'workspace.scope', severity: 'error', message: `Memory scope "${scope}" cannot carry a workspaceId.` },
              ])
            }
            const workspaceId: string | null = scope === 'workspace' ? command.workspaceId! : null
            const trimmed = validateContent(content, scope, workspaceId)
            await validateDuplicateAndPolicy(trimmed, scope, workspaceId, importance)
            const timestamp = now()
            const record: MemoryRecord = {
              id: newId(),
              scope,
              workspaceId,
              content: trimmed,
              importance,
              status: 'active',
              revision: 1,
              createdAt: timestamp.toISOString(),
              updatedAt: timestamp.toISOString(),
              deletedAt: null,
            }
            return {
              primary: record,
              insertRecords: [record],
              replaceRecords: [],
              deleteRecords: [],
              redactAuditForRecords: [],
              audit: [makeAuditEvent(context, {
                recordId: record.id,
                scope: record.scope,
                workspaceId: record.workspaceId,
                operation: 'create',
                expectedRevision: null,
                committedRevision: 1,
                beforeContent: null,
                afterContent: record.content,
              })],
            }
          }
          case 'update': {
            const { recordId, expectedRevision, changes } = command
            const record = await loadCurrent(recordId, expectedRevision)
            if (record.status !== 'active' && record.status !== 'archived') {
              throw invalidTransition('update', record.status)
            }
            const content = changes.content !== undefined
              ? validateContent(changes.content, record.scope, record.workspaceId)
              : record.content
            const importance = changes.importance ?? record.importance
            await validateDuplicateAndPolicy(content, record.scope, record.workspaceId, importance, record.id)
            const timestamp = now()
            const updated: MemoryRecord = {
              ...record,
              content,
              importance,
              revision: record.revision + 1,
              updatedAt: timestamp.toISOString(),
            }
            return {
              primary: updated,
              insertRecords: [],
              replaceRecords: [updated],
              deleteRecords: [],
              redactAuditForRecords: [],
              audit: [makeAuditEvent(context, {
                recordId: record.id,
                scope: record.scope,
                workspaceId: record.workspaceId,
                operation: 'update',
                expectedRevision,
                committedRevision: record.revision + 1,
                beforeContent: record.content,
                afterContent: content,
              })],
            }
          }
          case 'archive': {
            const { recordId, expectedRevision } = command
            const record = await loadCurrent(recordId, expectedRevision)
            if (record.status !== 'active') throw invalidTransition('archive', record.status)
            const { updated, audit } = applyTransition(record, context, 'archive', 'archived')
            return { primary: updated, insertRecords: [], replaceRecords: [updated], deleteRecords: [], redactAuditForRecords: [], audit: [audit] }
          }
          case 'restore': {
            const { recordId, expectedRevision } = command
            const record = await loadCurrent(recordId, expectedRevision)
            if (record.status !== 'archived') throw invalidTransition('restore', record.status)
            const { updated, audit } = applyTransition(record, context, 'restore', 'active')
            return { primary: updated, insertRecords: [], replaceRecords: [updated], deleteRecords: [], redactAuditForRecords: [], audit: [audit] }
          }
          case 'delete': {
            const { recordId, expectedRevision } = command
            const record = await loadCurrent(recordId, expectedRevision)
            if (record.status !== 'active' && record.status !== 'archived') {
              throw invalidTransition('delete', record.status)
            }
            const { updated, audit } = applyTransition(record, context, 'delete', 'deleted', { deletedAt: now().toISOString() })
            return { primary: updated, insertRecords: [], replaceRecords: [updated], deleteRecords: [], redactAuditForRecords: [], audit: [audit] }
          }
          case 'purge': {
            const { recordId, expectedRevision } = command
            const record = await loadCurrent(recordId, expectedRevision)
            // Any status (pinned decision 4) → hard delete. Task 9: prior
            // audit events for this record are REDACTED in the same commit
            // (redactAuditForRecords nulls their before/after content) and the
            // final purge event itself carries NO content — deletion surfaces
            // only the metadata trail, never the erased bytes.
            const audit = makeAuditEvent(context, {
              recordId: record.id,
              scope: record.scope,
              workspaceId: record.workspaceId,
              operation: 'purge',
              expectedRevision,
              committedRevision: record.revision + 1,
              beforeContent: null,
              afterContent: null,
            })
            return { primary: null, insertRecords: [], replaceRecords: [], deleteRecords: [record.id], redactAuditForRecords: [record.id], audit: [audit] }
          }
        }
      })
    },

    /**
     * Task 9: audit trail query. Collects via storage.scanAudit({ recordId })
     * (the storage-level limit would truncate BEFORE our filters → not
     * passed), filters scope/workspaceId client-side, sorts newest first
     * (committedAt desc, id desc — ISO strings compare chronologically) and
     * applies `limit` AFTER sorting (spec verbatim).
     */
    async queryAudit(query: MemoryAuditQuery): Promise<MemoryAuditEvent[]> {
      assertRunning('queryAudit')
      const events: MemoryAuditEvent[] = []
      for await (const e of options.storage.scanAudit({ recordId: query.recordId })) {
        if (query.scope !== undefined && e.scope !== query.scope) continue
        if (query.workspaceId !== undefined && e.workspaceId !== query.workspaceId) continue
        events.push(e)
      }
      events.sort((a, b) => b.committedAt.localeCompare(a.committedAt) || b.id.localeCompare(a.id))
      return query.limit !== undefined ? events.slice(0, query.limit) : events
    },
  }

  return { start, stop, bind, admin }
}

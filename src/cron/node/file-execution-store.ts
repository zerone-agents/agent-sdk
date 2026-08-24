import { randomUUID } from 'node:crypto'
import path from 'node:path'

import type {
  ExecutionClaimInput,
  ExecutionClaimResult,
  ExecutionStatusPatch,
  ExecutionStore,
} from '../execution-store.js'
import { reportCronDiagnostic, type CronDiagnosticSink } from '../events.js'
import type {
  CronExecution,
  CronExecutionQuery,
  CronExecutionStatus,
} from '../types.js'
import { ExecutionLog } from './execution-log.js'
import { atomicWriteJson } from './json-utils.js'

function isActive(execution: CronExecution): boolean {
  return execution.status === 'pending' || execution.status === 'running'
}

/**
 * Filesystem ExecutionStore backed by the append-only JSONL log (source of
 * truth) plus a write-through `execution-index.json` snapshot (observability;
 * always rebuildable from the log).
 *
 * Concurrency model (atomic claim, issue #42): EVERY public operation runs
 * its read → decide → mutate → append sequence inside the single serialized
 * transaction chain. Memory therefore never exposes speculative
 * (not-yet-durable) state to another operation: a transaction's mutations are
 * either durable (append succeeded) or fully rolled back before the next
 * queued operation runs. Index snapshots taken inside the chain only ever
 * contain durable records.
 */
export class FileExecutionStore implements ExecutionStore {
  private readonly log: ExecutionLog
  private readonly indexPath: string
  private executions = new Map<string, CronExecution>()
  /** Scheduled DEFAULT identity `${taskId}:${scheduledFireTime}` -> executionId. Permanent by design. */
  private byFire = new Map<string, string>()
  /** Manual custom identity (dedupKey) -> executionId. Process-local by contract. */
  private byDedup = new Map<string, string>()
  private activeByTask = new Map<string, string>()
  private loaded = false
  /** Shared in-flight load so concurrent callers cannot clobber memory state. */
  private loadPromise: Promise<void> | null = null
  private seq = 0
  private writeChain: Promise<unknown> = Promise.resolve()
  /**
   * Set when a source-of-truth append fails: the durability of that append
   * is uncertain (nothing / torn / fully written) and the log tail may be
   * torn. A poisoned store refuses every further operation on this instance
   * — accepting more writes could append a newline-terminated record onto
   * torn bytes, turning an ignorable replay tail into mid-log corruption.
   * Recovery requires a fresh instance (or restart) to replay the log.
   */
  private poisoned: string | null = null

  private readonly onDiagnostic?: CronDiagnosticSink

  constructor(cronDir: string, opts?: { onDiagnostic?: CronDiagnosticSink }) {
    this.log = new ExecutionLog(path.join(cronDir, 'executions.jsonl'))
    this.indexPath = path.join(cronDir, 'execution-index.json')
    this.onDiagnostic = opts?.onDiagnostic
  }

  async recoverInterrupted(): Promise<number> {
    this.assertHealthy()
    await this.ensureLoaded()
    // One transaction for the whole sweep: concurrent claims must not observe
    // the speculative transition of any record, and a mid-loop append failure
    // rolls back only its own record (earlier ones are already durable).
    return this.serialize(async () => {
      let count = 0
      for (const ex of [...this.executions.values()]) {
        if (!isActive(ex)) continue
        await this.commit({
          ...ex,
          status: 'interrupted',
          completedAt: Date.now(),
          error: 'recovered as interrupted at startup',
        })
        count++
      }
      return count
    })
  }

  async claim(input: ExecutionClaimInput): Promise<ExecutionClaimResult> {
    this.assertHealthy()
    await this.ensureLoaded()
    // Read EVERY caller-owned field exactly ONCE into SDK-owned locals. The
    // input may be a getter/Proxy whose properties return different values
    // on successive reads — re-reading after validation would let a hostile
    // object pass one shape through validation and enqueue another. Below
    // this block, the caller object is never touched again.
    const rawTrigger: unknown = (input as { trigger?: unknown }).trigger
    const rawDedupKey: unknown = (input as { dedupKey?: unknown }).dedupKey
    const rawTaskId: unknown = (input as { taskId?: unknown }).taskId
    const rawFireTime: unknown = (input as { scheduledFireTime?: unknown }).scheduledFireTime
    // Full runtime validation for JS/host callers bypassing the compile-time
    // union. Trigger must be an exact known value: anything else must not fall
    // through to the scheduled path (it would create an illegal CronExecution,
    // register in byFire now, yet replay only rebuilds byFire for exact
    // 'scheduled' — silently changing permanent dedup across a restart).
    if (rawTrigger !== 'manual' && rawTrigger !== 'scheduled') {
      throw new TypeError(`unknown cron execution trigger: ${String(rawTrigger)}`)
    }
    if (typeof rawTaskId !== 'string' || typeof rawFireTime !== 'number') {
      throw new TypeError('claim input requires taskId (string) and scheduledFireTime (number)')
    }
    // Canonical snapshot built from the locals only: nested branches so
    // control-flow analysis narrows rawDedupKey to string for manual claims.
    // A manual claim with a missing/null/empty key would either fall back to
    // the DEFAULT identity (silently breaking cross-restart dedup) or collapse
    // every submission onto one key; a scheduled claim carrying a key violates
    // the DEFAULT-identity contract. Refuse loudly instead.
    let request: ExecutionClaimInput
    if (rawTrigger === 'manual') {
      if (typeof rawDedupKey !== 'string' || rawDedupKey.length === 0) {
        throw new TypeError('manual claim requires a non-empty string dedupKey (custom identity)')
      }
      request = {
        taskId: rawTaskId,
        scheduledFireTime: rawFireTime,
        trigger: 'manual',
        dedupKey: rawDedupKey,
      }
    } else {
      if (rawDedupKey !== undefined) {
        throw new TypeError('scheduled claim must not carry a dedupKey')
      }
      request = { taskId: rawTaskId, scheduledFireTime: rawFireTime, trigger: 'scheduled' }
    }
    // Identities are namespaced per kind: scheduled claims consult `byFire`
    // (the DEFAULT `${taskId}:${scheduledFireTime}` identity), manual claims
    // consult `byDedup` (the custom identity). A custom key whose text happens
    // to equal a DEFAULT key can therefore never occupy a scheduled slot.
    //
    // The ENTIRE check → decide → mutate → append sequence runs inside the
    // serialized transaction: no concurrent operation can observe the
    // speculative state staged by this claim, and a failed append rolls back
    // before the next queued operation runs.
    return this.serialize(async () => {
      const existingId =
        request.trigger === 'manual'
          ? this.byDedup.get(request.dedupKey)
          : this.byFire.get(this.fireKey(request.taskId, request.scheduledFireTime))
      if (existingId) {
        const existing = this.executions.get(existingId)
        if (existing) return { kind: 'duplicate', execution: { ...existing } }
      }
      const activeId = this.activeByTask.get(request.taskId)
      const created: CronExecution = {
        id: randomUUID(),
        cronTaskId: request.taskId,
        scheduledFireTime: request.scheduledFireTime,
        trigger: request.trigger,
        status: activeId ? 'skipped' : 'pending',
      }
      await this.commit(created, request)
      return { kind: activeId ? 'skipped' : 'claimed', execution: { ...created } }
    })
  }

  async get(executionId: string): Promise<CronExecution | null> {
    this.assertHealthy()
    await this.ensureLoaded()
    // Reads also run inside the transaction chain: a read must never observe
    // speculative (not-yet-durable) state staged by an in-flight write.
    return this.serialize(async () => {
      const ex = this.executions.get(executionId)
      return ex ? { ...ex } : null
    })
  }

  async list(query?: CronExecutionQuery): Promise<CronExecution[]> {
    this.assertHealthy()
    await this.ensureLoaded()
    return this.serialize(async () => {
      let out = [...this.executions.values()].sort(
        (a, b) => b.scheduledFireTime - a.scheduledFireTime || (a.id < b.id ? -1 : 1),
      )
      if (query?.cronTaskId) out = out.filter((e) => e.cronTaskId === query.cronTaskId)
      if (query?.status) out = out.filter((e) => e.status === query.status)
      const offset = query?.offset ?? 0
      const limit = query?.limit
      out = out.slice(offset, limit !== undefined ? offset + limit : undefined)
      return out.map((e) => ({ ...e }))
    })
  }

  async updateStatus(
    executionId: string,
    status: CronExecutionStatus,
    patch?: ExecutionStatusPatch,
  ): Promise<CronExecution | null> {
    this.assertHealthy()
    await this.ensureLoaded()
    return this.serialize(async () => {
      const existing = this.executions.get(executionId)
      if (!existing) return null
      const updated: CronExecution = { ...existing, status, ...(patch ?? {}) }
      await this.commit(updated)
      return { ...updated }
    })
  }

  private fireKey(taskId: string, fireTime: number): string {
    return `${taskId}:${fireTime}`
  }

  /**
   * Throws when the store is poisoned: after a failed source-of-truth append
   * the durability of that record is uncertain and the log tail may be torn,
   * so no further operation may run on THIS instance. Recovery = recreate the
   * store (or restart) so replay decides what actually got persisted.
   */
  private assertHealthy(): void {
    if (this.poisoned !== null) {
      throw new Error(
        `FileExecutionStore is unavailable after a failed log append (${this.poisoned}). ` +
          'Recreate the store (or restart) so the log can be replayed and recovered.',
      )
    }
  }

  private ensureLoaded(): Promise<void> {
    // Memoized: all callers share ONE in-flight replay (round-1 race guarantee).
    // On failure the memo is cleared so the NEXT call retries the load — a
    // transient replay error (EACCES/EMFILE) must not poison the store forever.
    this.loadPromise ??= this.doLoad().catch((err) => {
      this.loadPromise = null
      throw err
    })
    return this.loadPromise
  }

  private async doLoad(): Promise<void> {
    const { executions, seq, diagnostics } = await this.log.replay()
    // Torn-tail diagnostics are reported, never thrown: replay already
    // recovered all intact records, so the store stays fully functional.
    for (const d of diagnostics) reportCronDiagnostic(this.onDiagnostic, d)
    this.executions = executions
    this.seq = seq
    this.rebuildDerivedIndexes()
    this.loaded = true
    // Physically normalize the tail BEFORE any transaction can append:
    // replay repaired only the in-memory view, and a subsequent append onto
    // torn bytes (or onto a delimiter-less complete record) would corrupt
    // the NEXT replay. doLoad precedes every transaction, so the repair is
    // inherently serialized with all later appends.
    const repair = await this.log.repairTail()
    if (repair !== null) reportCronDiagnostic(this.onDiagnostic, repair)
    await this.persistIndexBestEffort()
  }

  private rebuildDerivedIndexes(): void {
    this.byFire = new Map()
    // Custom identities are process-local by contract: replay derives none,
    // so the map starts empty. Cleared explicitly for symmetry with byFire.
    this.byDedup = new Map()
    this.activeByTask = new Map()
    for (const ex of this.executions.values()) {
      // The DEFAULT identity is derived ONLY for scheduled records: manual
      // records claimed a custom dedupKey that is process-local by contract,
      // so replay derives no DEFAULT entry for them — a manual run must never
      // occupy a scheduled slot.
      if (ex.trigger === 'scheduled') {
        this.byFire.set(this.fireKey(ex.cronTaskId, ex.scheduledFireTime), ex.id)
      }
      // The active set is trigger-agnostic: the at-most-one-active guarantee
      // must survive restarts for manual executions too, otherwise a manual
      // run that crashed mid-flight would silently stop blocking new claims
      // until recoverInterrupted() runs.
      if (isActive(ex)) this.activeByTask.set(ex.cronTaskId, ex.id)
    }
  }

  /**
   * Mutate memory + persist durably. MUST be called from inside a serialize()
   * transaction (every public method wraps its body); commit() itself never
   * re-enters the chain.
   *
   * If the source-of-truth append fails, the in-memory changes are rolled
   * back before the chain proceeds to the next operation — a failed commit
   * leaves no phantom record, identity, or active slot, so a later operation
   * cannot observe a phantom duplicate/skipped or a silently freed active
   * slot. Restores are unconditional snapshot reverts: safe because the
   * transaction chain guarantees nothing interleaves between the mutation and
   * the rollback. `seq` is intentionally NOT decremented: a monotonic gap is
   * harmless, and a possibly-torn append must never be renumbered onto by a
   * later record.
   */
  private async commit(execution: CronExecution, claimInput?: ExecutionClaimInput): Promise<void> {
    const prevExecution = this.executions.get(execution.id)
    let fireIdentity: { key: string; prev: string | undefined } | undefined
    let dedupIdentity: { key: string; prev: string | undefined } | undefined
    const prevActive = this.activeByTask.get(execution.cronTaskId)

    this.executions.set(execution.id, execution)
    // The dedup identity is registered ONLY at claim time: updateStatus and
    // recoverInterrupted pass no claim input, so they must not touch the
    // identity maps. Registration is namespaced per kind — a manual record
    // claimed under `manual:<uuid>` lives in `byDedup` and never occupies the
    // scheduled DEFAULT slot in `byFire`, whatever the key text looks like.
    if (claimInput !== undefined) {
      if (claimInput.trigger === 'manual') {
        const key = claimInput.dedupKey
        dedupIdentity = { key, prev: this.byDedup.get(key) }
        this.byDedup.set(key, execution.id)
      } else {
        const key = this.fireKey(claimInput.taskId, claimInput.scheduledFireTime)
        fireIdentity = { key, prev: this.byFire.get(key) }
        this.byFire.set(key, execution.id)
      }
    }
    if (isActive(execution)) {
      this.activeByTask.set(execution.cronTaskId, execution.id)
    } else if (this.activeByTask.get(execution.cronTaskId) === execution.id) {
      this.activeByTask.delete(execution.cronTaskId)
    }

    try {
      this.seq += 1
      await this.log.append(this.seq, execution)
      await this.persistIndexBestEffort()
    } catch (err) {
      if (prevExecution === undefined) this.executions.delete(execution.id)
      else this.executions.set(execution.id, prevExecution)
      if (fireIdentity) {
        if (fireIdentity.prev === undefined) this.byFire.delete(fireIdentity.key)
        else this.byFire.set(fireIdentity.key, fireIdentity.prev)
      }
      if (dedupIdentity) {
        if (dedupIdentity.prev === undefined) this.byDedup.delete(dedupIdentity.key)
        else this.byDedup.set(dedupIdentity.key, dedupIdentity.prev)
      }
      if (prevActive === undefined) this.activeByTask.delete(execution.cronTaskId)
      else this.activeByTask.set(execution.cronTaskId, prevActive)
      // Poison the store: the failed append's durability is uncertain (the
      // bytes may be absent, torn, or fully written) and only a replay by a
      // fresh instance can settle it. This instance must accept no further
      // operations — see assertHealthy().
      this.poisoned = err instanceof Error ? err.message : String(err)
      throw err
    }
  }

  private async persistIndex(): Promise<void> {
    await atomicWriteJson(this.indexPath, {
      seq: this.seq,
      active: [...this.activeByTask.entries()],
      executions: [...this.executions.values()],
    })
  }

  /**
   * execution-index.json is a rebuildable observability snapshot, never the
   * source of truth — a write failure must not fail an already-durable claim
   * or load. Report it via the diagnostics channel instead.
   */
  private persistIndexBestEffort(): Promise<void> {
    return this.persistIndex().catch((err: unknown) => {
      reportCronDiagnostic(
        this.onDiagnostic,
        `failed to persist execution-index.json: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    })
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(async () => {
      // Queued transactions are refused once poisoned: a previous append
      // failed with uncertain durability — this instance must not decide or
      // write anything until the log is replayed by a fresh instance.
      this.assertHealthy()
      return fn()
    })
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}

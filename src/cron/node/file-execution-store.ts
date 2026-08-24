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
 * always rebuildable from the log). Claim/dedup bookkeeping lives in
 * in-memory maps that are updated synchronously before persistence, which
 * makes concurrent claims safe within the single-process contract.
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

  private readonly onDiagnostic?: CronDiagnosticSink

  constructor(cronDir: string, opts?: { onDiagnostic?: CronDiagnosticSink }) {
    this.log = new ExecutionLog(path.join(cronDir, 'executions.jsonl'))
    this.indexPath = path.join(cronDir, 'execution-index.json')
    this.onDiagnostic = opts?.onDiagnostic
  }

  async recoverInterrupted(): Promise<number> {
    await this.ensureLoaded()
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
  }

  async claim(input: ExecutionClaimInput): Promise<ExecutionClaimResult> {
    await this.ensureLoaded()
    // Full runtime validation for JS/host callers bypassing the compile-time
    // union. Trigger must be an exact known value: anything else must not fall
    // through to the scheduled path (it would create an illegal CronExecution,
    // register in byFire now, yet replay only rebuilds byFire for exact
    // 'scheduled' — silently changing permanent dedup across a restart).
    const trigger = (input as { trigger?: unknown }).trigger
    if (trigger !== 'manual' && trigger !== 'scheduled') {
      throw new TypeError(`unknown cron execution trigger: ${String(trigger)}`)
    }
    // A manual claim with a missing/null/empty key would either fall back to
    // the DEFAULT identity (silently breaking cross-restart dedup) or collapse
    // every submission onto one key; a scheduled claim carrying a key violates
    // the DEFAULT-identity contract. Refuse loudly instead.
    if (input.trigger === 'manual') {
      const key = (input as { dedupKey?: unknown }).dedupKey
      if (typeof key !== 'string' || key.length === 0) {
        throw new TypeError('manual claim requires a non-empty string dedupKey (custom identity)')
      }
    } else if ((input as { dedupKey?: unknown }).dedupKey !== undefined) {
      throw new TypeError('scheduled claim must not carry a dedupKey')
    }
    // Memory maps are read AND written synchronously below (commit mutates
    // memory before its first await), so concurrent claims cannot race.
    // Identities are namespaced per kind: scheduled claims consult `byFire`
    // (the DEFAULT `${taskId}:${scheduledFireTime}` identity), manual claims
    // consult `byDedup` (the custom identity). A custom key whose text happens
    // to equal a DEFAULT key can therefore never occupy a scheduled slot.
    const existingId =
      input.trigger === 'manual'
        ? this.byDedup.get(input.dedupKey)
        : this.byFire.get(this.fireKey(input.taskId, input.scheduledFireTime))
    if (existingId) {
      const existing = this.executions.get(existingId)
      if (existing) return { kind: 'duplicate', execution: { ...existing } }
    }
    const activeId = this.activeByTask.get(input.taskId)
    const created: CronExecution = {
      id: randomUUID(),
      cronTaskId: input.taskId,
      scheduledFireTime: input.scheduledFireTime,
      trigger: input.trigger,
      status: activeId ? 'skipped' : 'pending',
    }
    await this.commit(created, input)
    return { kind: activeId ? 'skipped' : 'claimed', execution: { ...created } }
  }

  async get(executionId: string): Promise<CronExecution | null> {
    await this.ensureLoaded()
    const ex = this.executions.get(executionId)
    return ex ? { ...ex } : null
  }

  async list(query?: CronExecutionQuery): Promise<CronExecution[]> {
    await this.ensureLoaded()
    let out = [...this.executions.values()].sort(
      (a, b) => b.scheduledFireTime - a.scheduledFireTime || (a.id < b.id ? -1 : 1),
    )
    if (query?.cronTaskId) out = out.filter((e) => e.cronTaskId === query.cronTaskId)
    if (query?.status) out = out.filter((e) => e.status === query.status)
    const offset = query?.offset ?? 0
    const limit = query?.limit
    out = out.slice(offset, limit !== undefined ? offset + limit : undefined)
    return out.map((e) => ({ ...e }))
  }

  async updateStatus(
    executionId: string,
    status: CronExecutionStatus,
    patch?: ExecutionStatusPatch,
  ): Promise<CronExecution | null> {
    await this.ensureLoaded()
    const existing = this.executions.get(executionId)
    if (!existing) return null
    const updated: CronExecution = { ...existing, status, ...(patch ?? {}) }
    await this.commit(updated)
    return { ...updated }
  }

  private fireKey(taskId: string, fireTime: number): string {
    return `${taskId}:${fireTime}`
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

  private async commit(execution: CronExecution, claimInput?: ExecutionClaimInput): Promise<void> {
    // Memory is mutated synchronously BEFORE the durable write so concurrent
    // claims see a consistent view (single-process atomicity). If the
    // source-of-truth append then fails, the in-memory changes are rolled
    // back — a failed claim must leave no phantom record, identity, or active
    // slot, so a retry cannot observe a phantom duplicate/skipped.
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
      await this.serialize(async () => {
        this.seq += 1
        await this.log.append(this.seq, execution)
        await this.persistIndexBestEffort()
      })
    } catch (err) {
      // Roll back memory: the commit failed, so nothing it staged may remain
      // observable. Restores are CONDITIONAL — each entry is reverted only
      // while it still holds THIS commit's value (or, for the active-slot
      // delete path, is still absent) — so an interleaved successful commit
      // is never clobbered. `seq` is intentionally NOT decremented: a
      // monotonic gap is harmless, and a possibly-torn append must never be
      // renumbered onto by a later record.
      if (this.executions.get(execution.id) === execution) {
        if (prevExecution === undefined) this.executions.delete(execution.id)
        else this.executions.set(execution.id, prevExecution)
      }
      if (fireIdentity && this.byFire.get(fireIdentity.key) === execution.id) {
        if (fireIdentity.prev === undefined) this.byFire.delete(fireIdentity.key)
        else this.byFire.set(fireIdentity.key, fireIdentity.prev)
      }
      if (dedupIdentity && this.byDedup.get(dedupIdentity.key) === execution.id) {
        if (dedupIdentity.prev === undefined) this.byDedup.delete(dedupIdentity.key)
        else this.byDedup.set(dedupIdentity.key, dedupIdentity.prev)
      }
      // Active-slot revert condition differs per branch: we either SET our id
      // (active execution) or DELETED our id (terminal transition).
      const currentActive = this.activeByTask.get(execution.cronTaskId)
      if (isActive(execution) ? currentActive === execution.id : currentActive === undefined) {
        if (prevActive === undefined) this.activeByTask.delete(execution.cronTaskId)
        else this.activeByTask.set(execution.cronTaskId, prevActive)
      }
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
    const run = this.writeChain.then(fn, fn)
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}

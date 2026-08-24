import { randomUUID } from 'node:crypto'
import path from 'node:path'

import type {
  ExecutionClaimResult,
  ExecutionStatusPatch,
  ExecutionStore,
} from '../execution-store.js'
import { reportCronDiagnostic, type CronDiagnosticSink } from '../events.js'
import type {
  CronExecution,
  CronExecutionQuery,
  CronExecutionStatus,
  CronExecutionTrigger,
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
  /** `${taskId}:${scheduledFireTime}` -> executionId. Permanent by design. */
  private byFire = new Map<string, string>()
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

  async claim(input: {
    taskId: string
    scheduledFireTime: number
    trigger: CronExecutionTrigger
    dedupKey?: string
  }): Promise<ExecutionClaimResult> {
    await this.ensureLoaded()
    // Memory maps are read AND written synchronously below (commit mutates
    // memory before its first await), so concurrent claims cannot race.
    // An explicit dedupKey (manual triggers) decouples identity from time;
    // without one the default `${taskId}:${scheduledFireTime}` applies,
    // keeping scheduled restart-dedup byte-identical.
    const key = input.dedupKey ?? this.fireKey(input.taskId, input.scheduledFireTime)
    const existingId = this.byFire.get(key)
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
    await this.commit(created, key)
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
    await this.persistIndex().catch(() => {})
  }

  private rebuildDerivedIndexes(): void {
    this.byFire = new Map()
    this.activeByTask = new Map()
    for (const ex of this.executions.values()) {
      // Manual records claim a unique custom dedupKey at claim time; that
      // identity is process-local by contract, so replay derives no DEFAULT
      // entry for them — a manual run must never occupy a scheduled slot.
      if (ex.trigger === 'manual') continue
      this.byFire.set(this.fireKey(ex.cronTaskId, ex.scheduledFireTime), ex.id)
      if (isActive(ex)) this.activeByTask.set(ex.cronTaskId, ex.id)
    }
  }

  private async commit(execution: CronExecution, key?: string): Promise<void> {
    this.executions.set(execution.id, execution)
    // The dedup identity is registered ONLY at claim time: updateStatus and
    // recoverInterrupted pass no key, so they must not touch `byFire`. A
    // manual record claimed under `manual:<uuid>` therefore never also
    // occupies the default `${taskId}:${scheduledFireTime}` slot.
    if (key !== undefined) this.byFire.set(key, execution.id)
    if (isActive(execution)) {
      this.activeByTask.set(execution.cronTaskId, execution.id)
    } else if (this.activeByTask.get(execution.cronTaskId) === execution.id) {
      this.activeByTask.delete(execution.cronTaskId)
    }
    await this.serialize(async () => {
      this.seq += 1
      await this.log.append(this.seq, execution)
      await this.persistIndex()
    })
  }

  private async persistIndex(): Promise<void> {
    await atomicWriteJson(this.indexPath, {
      seq: this.seq,
      active: [...this.activeByTask.entries()],
      executions: [...this.executions.values()],
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

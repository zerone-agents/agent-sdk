/**
 * WriteCoordinator——所有写入路径的统一编排入口（issue #131）。
 *
 * 状态机：prepare → journal.persist → 分发到 store → journal.release。
 * - commit 成功 + release 失败 → 返回 receipt（committed-pending-handoff——原 prepared 保留供恢复）
 * - commit 明确失败 → throw（不调 release）——上游可 retry(原 prepared) 或新 execute
 * - query 三态：原回执 / null（not-committed）/ 抛错（recycled 或查询故障——不折叠为 null）
 * - retry：提交原 prepared（同 operationId，不重新生成——commit 成功后永不重新 prepare）
 */
import type { ActorRef, AuthorizationContext, OperationIntent, OperationReceipt, PreparedOperation } from './types.js'
import type { SessionStore } from './session-store.js'
import { prepareOperation } from './prepare.js'
import { NoopJournal, type OperationJournal } from './journal.js'

export interface WriteCoordinatorOptions {
  store: SessionStore
  journal?: OperationJournal
  fencing?: { identity: AuthorizationContext }
  actor?: ActorRef
}

/** commit 结果未知（超时/网络）——携带原 prepared 供上游 query/retry */
export class CoordinatorUnknownError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly prepared: PreparedOperation,
    public readonly cause: unknown,
  ) {
    super(`commit result unknown for operation ${prepared.operationId} on ${sessionId}: ${String(cause)}`)
    this.name = 'CoordinatorUnknownError'
  }
}

export class WriteCoordinator {
  private readonly store: SessionStore
  private readonly journal: OperationJournal
  private readonly fencing?: { identity: AuthorizationContext }
  private readonly actor?: ActorRef

  constructor(opts: WriteCoordinatorOptions) {
    this.store = opts.store
    this.journal = opts.journal ?? new NoopJournal()
    this.fencing = opts.fencing
    this.actor = opts.actor
  }

  /** 首次执行：prepare → journal.persist → 分发到 store → journal.release */
  async execute(sessionId: string, intent: OperationIntent): Promise<OperationReceipt> {
    const prepared = prepareOperation(sessionId, intent, {
      ...(this.actor !== undefined ? { actor: this.actor } : {}),
      ...(this.fencing !== undefined ? { auth: this.fencing.identity } : {}),
    })
    return this.dispatch(sessionId, prepared)
  }

  /** 查询（三态）：原回执 / null（not-committed）/ 抛错（recycled 或查询故障） */
  async query(sessionId: string, operationId: string): Promise<OperationReceipt | null> {
    const result = await this.store.queryOperation(sessionId, operationId)
    if (result.status === 'committed') return result.receipt
    if (result.status === 'not-committed') return null
    // recycled 或查询故障 → 抛错（不折叠为 null——spec §5.4 不误判）
    throw new Error(`operation ${operationId} on ${sessionId}: ${result.status}`)
  }

  /** 重试：提交原 prepared（从 journal 恢复）——同 operationId，不重新生成 */
  async retry(sessionId: string, prepared: PreparedOperation): Promise<OperationReceipt> {
    return this.dispatch(sessionId, prepared)
  }

  /** 内部分发：journal.persist → store 对应入口 → journal.release */
  private async dispatch(sessionId: string, prepared: PreparedOperation): Promise<OperationReceipt> {
    await this.journal.persist(prepared)
    let receipt: OperationReceipt
    try {
      const auth = this.fencing?.identity
      if (prepared.kind === 'save-todos') {
        receipt = await this.store.saveTodos(sessionId, prepared, auth !== undefined ? { auth } : undefined)
      } else if (prepared.kind === 'delete') {
        receipt = await this.store.deleteSession(sessionId, prepared, auth !== undefined ? { auth } : undefined)
      } else {
        // transcript kinds + register + fork + import → store.commit
        receipt = await this.store.commit(sessionId, prepared, auth !== undefined ? { auth } : undefined)
      }
    } catch (err) {
      // commit 明确失败 → 不调 release（journal 条目保留供 retry）
      throw err
    }
    // commit 成功 → release（失败仅 warn，不影响返回——committed-pending-handoff）
    try {
      await this.journal.release(prepared.operationId)
    } catch {
      // release 失败：commit 已成功，不视为整体失败——原 prepared 保留供 recover
    }
    return receipt
  }
}
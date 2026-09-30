/** v4 SessionStore 契约错误（issue #131 SPEC §3.2）。
 * SessionConflictError / SessionDataInvalidError 自 v3 搬迁至此（P3 退场统一收口）。 */
import type { PreparedOperation, OperationReceipt } from './types.js'

/** 乐观并发冲突（revision CAS / create-only）。 */
export class SessionConflictError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly expectedRevision: number | null,
    public readonly actualRevision?: number,
  ) {
    super(
      `Session conflict on ${sessionId}: expected ${
        expectedRevision === null ? 'no existing session (create-only)' : `revision ${expectedRevision}`
      }${actualRevision === undefined ? '' : `, found revision ${actualRevision}`}`,
    )
    this.name = 'SessionConflictError'
  }
}

/** 会话数据形状非法（运行时校验）。 */
export class SessionDataInvalidError extends Error {
  constructor(public readonly sessionId: string, reason: string) {
    super(`Invalid session data for ${sessionId}: ${reason}`)
    this.name = 'SessionDataInvalidError'
  }
}

/** resume/import 目标会话不存在。 */
export class SessionNotFoundError extends Error {
  constructor(public readonly sessionId: string) {
    super(`Session not found: ${sessionId}`)
    this.name = 'SessionNotFoundError'
  }
}

/** close() 超时后的完成句柄载荷（R22）——追踪整个 checkpoint 生命周期。 */
export type CheckpointCompletion =
  | { status: 'committed'; receipt?: OperationReceipt; prepared?: PreparedOperation }
  | { status: 'failed'; error: unknown; prepared?: PreparedOperation }

/** close() 等待落盘超时——§8.2（评审 R16/R22）：prepared + completion 双恢复句柄。 */
export class SessionCloseTimeoutError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly timeoutMs: number,
    /**
     * 超时时在途的 prepared（若有）——宿主以 `coordinator.query(operationId)` 判定结果；
     * 未提交则以 `retry(prepared)` 恢复**同一操作**（不清 pending 直到判定）。
     */
    public readonly prepared?: PreparedOperation,
    /**
     * R22：completion 句柄——超时后 checkpoint 仍在进行时兑现最终结果
     *（committed 携 receipt / failed 携错误），覆盖「超时时尚未 prepare、之后仍会
     * 提交」的场景。宿主应 await 该句柄再决定 query/retry 或释放租约；不能把
     * 「目前未 prepare」当成「后续不会写」。
     */
    public readonly completion?: Promise<CheckpointCompletion>,
  ) {
    super(
      `close checkpoint timed out after ${timeoutMs}ms on ${sessionId}: `
      + (prepared !== undefined
        ? `outcome unknown for operation ${prepared.operationId} — query the coordinator, `
          + 'then retry the same prepared if not committed'
        : 'checkpoint still in progress (not yet prepared) — await the completion handle '
          + 'to trace the final outcome; do not start another close checkpoint before it settles'),
    )
    this.name = 'SessionCloseTimeoutError'
  }
}

/** fencing 校验失败（与 revision CAS 独立约束；P2 启用校验，P1 透传不校验）。 */
export class WriteNotAuthorizedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WriteNotAuthorizedError'
  }
}

/** 同 operationId 不同 fingerprint（重试复用 prepared，不得重新生成）。 */
export class OperationConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OperationConflictError'
  }
}

/** rollback/fork 目标非法（含拆散 tool_use/tool_result 配对）。 */
export class RollbackTargetInvalidError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RollbackTargetInvalidError'
  }
}

/** 登记归属不一致（同 session 不同 ownership 的重复 register）。 */
export class OwnershipMismatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OwnershipMismatchError'
  }
}

/** 形状校验错误快捷构造（保持与 v3 错误族一致）。 */
export function shapeError(sessionId: string, reason: string): SessionDataInvalidError {
  return new SessionDataInvalidError(sessionId, reason)
}
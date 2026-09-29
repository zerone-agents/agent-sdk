/** v4 SessionStore 契约错误（issue #131 SPEC §3.2）。
 * SessionConflictError / SessionDataInvalidError 自 v3 搬迁至此（P3 退场统一收口）。 */
import type { PreparedOperation } from './types.js'

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

/** close() 等待落盘超时——§8.2（评审 R16）：携带在途 prepared 作恢复句柄。 */
export class SessionCloseTimeoutError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly timeoutMs: number,
    /**
     * 超时时在途的 prepared（若有）——宿主以 `coordinator.query(operationId)` 判定结果；
     * 未提交则以 `retry(prepared)` 恢复**同一操作**（不清 pending 直到判定）。
     * undefined = 尚未 prepare（写入未开始——可直接重试关闭）。
     */
    public readonly prepared?: PreparedOperation,
  ) {
    super(
      `close checkpoint timed out after ${timeoutMs}ms on ${sessionId}: `
      + (prepared !== undefined
        ? `outcome unknown for operation ${prepared.operationId} — query the coordinator, `
          + 'then retry the same prepared if not committed'
        : 'no operation was in flight yet (not prepared) — safe to retry close'),
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
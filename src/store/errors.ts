/** v4 SessionStore 契约错误（issue #131 SPEC §3.2）。
 * SessionConflictError / SessionDataInvalidError 复用 v3（P3 退场时统一搬迁）。 */
import { SessionDataInvalidError } from '../session-storage.js'

export { SessionConflictError, SessionDataInvalidError } from '../session-storage.js'

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
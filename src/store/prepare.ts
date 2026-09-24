/**
 * prepareOperation —— 纯冻结层（issue #131，spec §5.1；总览 §0 职责分层）。
 *
 * - 不做任何存储 IO：领域规划（ChangeSet 计算）在 SDK 编排层的 plan* 函数完成，
 *   本函数只做「冻结 + 指纹 + 边界校验」。
 * - 每次调用生成**新** prepared（新 operationId）——幂等的唯一来源是复用同一份
 *   journaled prepared；重试禁止重新 prepare（重新 prepare = 重新规划 = 新操作）。
 */
import { randomUUID } from 'node:crypto'
import { assertIntentShape, type ActorRef, type AuthorizationContext, type OperationIntent, type PreparedOperation } from './types.js'
import { fingerprintOperation } from './fingerprint.js'

export interface PrepareOptions {
  /** 执行者（默认 { kind: 'sdk' }；编排层传 main/subagent/app-op）。不参与指纹。 */
  actor?: ActorRef
  /** fencing 绑定身份（实例创建时静态绑定，spec §6.1）。不参与指纹。 */
  auth?: AuthorizationContext
}

export function prepareOperation(
  sessionId: string,
  intent: OperationIntent,
  opts?: PrepareOptions,
): PreparedOperation {
  assertIntentShape(sessionId, intent)
  const base = {
    operationId: randomUUID(),
    sessionId,
    actor: opts?.actor ?? { kind: 'sdk' as const },
    ...(opts?.auth !== undefined ? { auth: opts.auth } : {}),
  }

  if ('changeSet' in intent) {
    const kind = intent.kind as PreparedOperation['kind']
    const payload = intent.changeSet
    const expectedRevision = intent.expectedRevision
    return {
      ...base,
      kind,
      payload,
      expectedRevision,
      fingerprint: fingerprintOperation(sessionId, kind, payload, expectedRevision),
    } as PreparedOperation
  }

  switch (intent.kind) {
    case 'save-todos': {
      const payload = {
        todos: intent.todos,
        ...(intent.ownership !== undefined ? { ownership: intent.ownership } : {}),
      }
      return {
        ...base,
        kind: 'save-todos' as const,
        payload,
        fingerprint: fingerprintOperation(sessionId, 'save-todos', payload),
      } as PreparedOperation
    }
    case 'delete': {
      const payload = intent.cascadeOwned === undefined ? {} : { cascadeOwned: intent.cascadeOwned }
      return {
        ...base,
        kind: 'delete' as const,
        payload,
        fingerprint: fingerprintOperation(sessionId, 'delete', payload),
      } as PreparedOperation
    }
    case 'register': {
      const payload = { ownership: intent.ownership }
      return {
        ...base,
        kind: 'register' as const,
        payload,
        fingerprint: fingerprintOperation(sessionId, 'register', payload),
      } as PreparedOperation
    }
    default: {
      // unreachable: intent union exhausted above ('changeSet' in intent covers transcript kinds)
      throw new Error(`unsupported intent kind: ${String((intent as { kind?: string }).kind)}`)
    }
  }
}
/**
 * 操作指纹（issue #131，spec §5.3 定稿）：
 * `SHA-256(canonicalJSON({ sessionId, kind, payload, expectedRevision }))`
 * - canonicalJSON：对象键递归排序、无多余空白、UTF-8；undefined 值键不参与
 * - payload 为业务参数本体（ChangeSet / todos / cascadeOwned / ownership）
 * - expectedRevision 参与指纹（版本前提是操作的一部分——重新规划 = 新指纹）
 * - 唯一排除 auth（fencing 身份是执行条件；重新授权重试不改指纹）
 */
import { createHash } from 'node:crypto'
import type { ChangeSet, OperationKind, SessionOwnership } from './types.js'
import type { TodoInfo } from '../types.js'

export type OperationPayload =
  | ChangeSet
  | { todos: TodoInfo[]; ownership?: SessionOwnership }
  | { cascadeOwned?: boolean }
  | { ownership: SessionOwnership }

export function canonicalJSON(value: unknown): string {
  if (value === undefined) return 'null' // 防御：顶层不应出现；对象分支已过滤 undefined 键
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(obj[k])}`).join(',')}}`
}

export function fingerprintOperation(
  sessionId: string,
  kind: OperationKind,
  payload: OperationPayload,
  expectedRevision?: number | null,
): string {
  return createHash('sha256')
    .update(canonicalJSON({ sessionId, kind, payload, expectedRevision }), 'utf8')
    .digest('hex')
}
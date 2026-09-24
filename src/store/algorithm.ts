/**
 * SessionStore v4 SDK 域算法（issue #131，SPEC v1.4）。
 * 全部为纯函数：领域规划在 SDK（总览 §0 职责分层），adapter 不承担。
 */
import type { MessageRecord } from './types.js'
import { SessionDataInvalidError } from './errors.js'

export type RecordLookup = (recordId: string) => Pick<MessageRecord, 'messageId' | 'kind'> | undefined

/**
 * 折叠（spec §2.2-#2/#5）：由追加日志生成 effective——
 * 每 messageId 取**最后出现版本**，顺序 = **首现序**；`kind:'summary'` 记录不进入
 * effective（审计视图按压缩事件呈现）。保证 effective ⊆ logs。
 */
export function foldEffective(
  logs: readonly string[],
  lookup: RecordLookup,
  sessionId = '(unknown)',
): string[] {
  const firstAppearance: string[] = []
  const latest = new Map<string, string>()
  for (const recordId of logs) {
    const meta = lookup(recordId)
    if (!meta) {
      throw new SessionDataInvalidError(sessionId, `unknown record id in logs: ${recordId}`)
    }
    if (meta.kind === 'summary') continue
    if (!latest.has(meta.messageId)) firstAppearance.push(meta.messageId)
    latest.set(meta.messageId, recordId)
  }
  return firstAppearance.map((messageId) => latest.get(messageId)!)
}
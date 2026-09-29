/**
 * CommittedMessageIndex——Agent 维护的 messageId → 已提交 recordId 映射（issue #131）。
 *
 * **rebuild 从 branch.records（完整追加日志，含 summary 记录）**——不从 effective。
 * 这确保 compact 产生的 summary 消息的 messageId 也被索引：resume 后 context 中的
 * summary 消息在下次 checkpoint 的 diff 中被判定为「已提交」→ 跳过，不重复保存。
 *
 * 语义：不做自动内容 diff——自动 checkpoint 只区分「新（不在 map）/已存在（在 map）」。
 * 修订仅经显式 SessionManager.revise() 入口。
 */
import type { NewRecord } from './types.js'
import type { NormalizedMessageParam } from '../providers/types.js'
import type { SessionStore } from './session-store.js'

export class CommittedMessageIndex {
  /** messageId → last committed recordId */
  private readonly map = new Map<string, string>()

  /**
   * checkpoint diff：history 中不在 map 的消息 → newRecords（增量，不重复提交）。
   * buildRecord 回调由调用方提供（Agent 用它生成带 actor 的 NewRecord）。
   */
  diff(
    history: readonly NormalizedMessageParam[],
    buildRecord: (message: NormalizedMessageParam) => NewRecord,
  ): NewRecord[] {
    const newRecords: NewRecord[] = []
    for (const message of history) {
      const messageId = (message as { id?: string }).id
      if (messageId === undefined) continue
      if (!this.map.has(messageId)) {
        newRecords.push(buildRecord(message))
      }
    }
    return newRecords
  }

  /** commit 成功后更新映射（推进游标）。 */
  apply(newRecords: readonly NewRecord[]): void {
    for (const nr of newRecords) {
      const messageId = (nr.message as { id?: string }).id
      if (messageId !== undefined) {
        this.map.set(messageId, nr.recordId)
      }
    }
  }

  /**
   * resume 时从 store 重建——从 **branch.records**（完整日志）加载。
   * 不从 branch.effective 过滤——确保 summary 记录的 messageId 也被索引。
   */
  static async rebuild(
    store: SessionStore,
    sessionId: string,
    branchId: string,
  ): Promise<CommittedMessageIndex> {
    const idx = new CommittedMessageIndex()
    const state = await store.loadSession(sessionId)
    if (!state) return idx
    const branch = state.branches.find((b) => b.branchId === branchId)
    if (!branch) return idx
    // Load ALL records from the full append log (including summaries)
    const records = await store.loadRecords(sessionId, branch.records)
    for (const record of records) {
      if (record !== null) {
        idx.map.set(record.messageId, record.recordId)
      }
    }
    return idx
  }
}
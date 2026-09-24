/**
 * SessionStore v4 SDK 域算法（issue #131，SPEC v1.4）。
 * 全部为纯函数：领域规划在 SDK（总览 §0 职责分层），adapter 不承担。
 */
import type { Branch, ContextRef, ContextSegment, CoversRef, MessageRecord } from './types.js'
import { RollbackTargetInvalidError, SessionDataInvalidError } from './errors.js'

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

/**
 * covers 生成（spec §2.2-#4 / §4.2）：把被覆盖的 context 前缀展开为
 * **仅消息记录**的有序版本列表——summary 段替换为其 covers.recordIds
 * （上一轮 planCompact 生成的 covers 已仅含消息记录，故**展开永远单层、无嵌套**；
 * 多轮 compact 不产生嵌套 covers）。纯拼接，不做存在性校验（apply/commit 边界负责）。
 */
export function buildCovers(branchId: string, segments: readonly ContextSegment[]): CoversRef {
  const recordIds: string[] = []
  for (const seg of segments) {
    if (seg.kind === 'records') {
      recordIds.push(...seg.recordIds)
    } else {
      recordIds.push(...seg.covers.recordIds)
    }
  }
  return { branchId, recordIds }
}

// ============================================================================
// rollback 五步重建（spec §4.3，App 冻结反例定稿）
// ============================================================================

export interface RollbackPlan {
  logs: string[]
  effective: string[]
  context: ContextRef
}

/**
 * rollback = 对话位置回退（以目标消息**创建时刻**为时间截断点）：
 * 1. effective 定位目标 messageId；2. logs 首现索引截断（时间截断）；
 * 3. 折叠生成新 effective（summary 排除，保证 effective ⊆ logs）；
 * 4. context 以**新有效历史为权威**重建（复用判定 / 失效摘要仅定位并整体移除）；
 * 5. tool 配对校验（基于新 effective）。
 */
export function rebuildRollback(
  sessionId: string,
  branch: Branch,
  records: ReadonlyMap<string, MessageRecord>,
  atMessageId: string,
): RollbackPlan {
  const inEffective = branch.effective.some((rid) => records.get(rid)?.messageId === atMessageId)
  if (!inEffective) {
    throw new RollbackTargetInvalidError(`rollback target not found in effective: ${atMessageId}`)
  }
  const firstIdx = branch.records.findIndex((rid) => records.get(rid)?.messageId === atMessageId)
  if (firstIdx === -1) {
    throw new RollbackTargetInvalidError(`rollback target not found in logs: ${atMessageId}`)
  }
  const logs = branch.records.slice(0, firstIdx + 1)
  const effective = foldEffective(logs, (rid) => records.get(rid), sessionId)
  const newEffectiveMap = new Map(effective.map((rid) => [records.get(rid)!.messageId, rid]))
  const context = rebuildContextAfterRollback(branch.context, new Set(logs), newEffectiveMap, records)
  assertToolPairing(sessionId, effective, records)
  return { logs, effective, context }
}

function rebuildContextAfterRollback(
  source: ContextRef,
  newLogs: Set<string>,
  newEffective: Map<string, string>,
  records: ReadonlyMap<string, MessageRecord>,
): ContextRef {
  const summarySeg = source.segments.find((s): s is Extract<ContextSegment, { kind: 'summary' }> => s.kind === 'summary')
  if (summarySeg && canReuseSummary(summarySeg, newLogs, newEffective, records)) {
    // 复用：[summary 段, 其余（新 effective 中不在 covers 内的消息，按序）]——互斥不重复
    const covered = new Set(summarySeg.covers.recordIds.map((rid) => records.get(rid)?.messageId))
    const rest = [...newEffective.entries()].filter(([mid]) => !covered.has(mid)).map(([, rid]) => rid)
    return { segments: rest.length > 0 ? [summarySeg, { kind: 'records', recordIds: rest }] : [summarySeg] }
  }
  // 失效（covers 越界/版本不一致）或无摘要：summary 段整体移除（仅定位作用），
  // 新 effective 全量作为 records 段——模型请求无未来内容、无失效摘要（spec §4.3 不变量）
  return { segments: [{ kind: 'records', recordIds: [...newEffective.values()] }] }
}

function canReuseSummary(
  seg: Extract<ContextSegment, { kind: 'summary' }>,
  newLogs: Set<string>,
  newEffective: Map<string, string>,
  records: ReadonlyMap<string, MessageRecord>,
): boolean {
  for (const rid of seg.covers.recordIds) {
    if (!newLogs.has(rid)) return false
    const rec = records.get(rid)
    if (!rec) return false
    if (newEffective.get(rec.messageId) !== rid) return false   // covers 版本 ≠ 新有效版本
  }
  return true
}

/** 新 effective 中 tool_use / tool_result 配对完整（集合相等）。 */
function assertToolPairing(sessionId: string, effective: readonly string[], records: ReadonlyMap<string, MessageRecord>): void {
  const used = new Set<string>()
  const resulted = new Set<string>()
  for (const rid of effective) {
    const msg = records.get(rid)?.message
    const blocks = msg && Array.isArray(msg.content) ? (msg.content as unknown[]) : []
    for (const b of blocks as Array<{ type?: string; id?: string; tool_use_id?: string }>) {
      if (b?.type === 'tool_use' && typeof b.id === 'string') used.add(b.id)
      if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string') resulted.add(b.tool_use_id)
    }
  }
  for (const id of used) {
    if (!resulted.has(id)) throw new RollbackTargetInvalidError(`rollback target splits tool_use/tool_result pair: tool_use ${id} has no result`)
  }
  for (const id of resulted) {
    if (!used.has(id)) throw new RollbackTargetInvalidError(`rollback target splits tool_use/tool_result pair: result ${id} has no tool_use`)
  }
}
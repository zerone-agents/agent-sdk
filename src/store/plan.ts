/**
 * plan* —— SDK 编排层的规划函数（issue #131；总览 §0 职责分层）。
 * 读存储/组装 ChangeSet 的领域规划全部在 SDK；adapter 不承担。
 * planCompact 为纯组装（时序接入在 P3 的 engine/Agent 编排）。
 */
import type { ChangeSet, ContextSegment, NewRecord } from './types.js'
import { buildCovers } from './algorithm.js'

export interface PlanCompactInput {
  branchId: string
  /** 被覆盖的 context 前缀（原样 segments；可含未持久化原文的引用与旧 summary 段）。 */
  coveredSegments: ContextSegment[]
  /** 将被覆盖且尚未持久化的原文记录（spec §4.2：与摘要同事务落盘）。 */
  pendingRecords: NewRecord[]
  /** 摘要记录（内容由编排层生成；kind 应为 'summary'）。 */
  summaryRecord: NewRecord
  /** 保留的 tail 段。 */
  keptSegment: ContextSegment
}

/** 组装 compact 变更集：newRecords = pending + summary；context = [summary 段(covers), kept]。 */
export function planCompact(input: PlanCompactInput): ChangeSet {
  const covers = buildCovers(input.branchId, input.coveredSegments)
  return {
    kind: 'compact',
    branchId: input.branchId,
    newRecords: [...input.pendingRecords, input.summaryRecord],
    context: {
      segments: [
        { kind: 'summary', summaryRecordId: input.summaryRecord.recordId, covers },
        input.keptSegment,
      ],
    },
    summary: { summaryRecordId: input.summaryRecord.recordId, covers },
  }
}
/**
 * plan* —— SDK 编排层的规划函数（issue #131；总览 §0 职责分层）。
 * 读存储/组装 ChangeSet 的领域规划全部在 SDK；adapter 不承担。
 * planCompact 为纯组装（时序接入在 P3 的 engine/Agent 编排）。
 */
import { randomUUID } from 'node:crypto'
import type { ChangeSet, ContextSegment, MessageRecord, NewRecord, SessionOwnership } from './types.js'
import { buildCovers, rebuildRollback } from './algorithm.js'
import { SessionDataInvalidError } from './errors.js'
import type { SessionStore } from './session-store.js'

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

/** 读 store + 五步重建计算 + 构造 rollback intent（SDK 规划层；expectedRevision = 当前快照）。 */
export async function planRollback(
  store: Pick<SessionStore, 'loadSession' | 'loadRecords'>,
  sessionId: string,
  branchId: string,
  atMessageId: string,
): Promise<{ kind: 'rollback'; expectedRevision: number; changeSet: ChangeSet }> {
  const state = await store.loadSession(sessionId)
  if (!state) throw new SessionDataInvalidError(sessionId, 'session not found')
  const branch = state.branches.find((b) => b.branchId === branchId)
  if (!branch) throw new SessionDataInvalidError(sessionId, `unknown branch: ${branchId}`)
  const loaded = await store.loadRecords(sessionId, branch.records)
  const records = new Map<string, MessageRecord>()
  branch.records.forEach((rid, i) => {
    const r = loaded[i]
    if (r) records.set(rid, r)
  })
  const plan = rebuildRollback(sessionId, branch, records, atMessageId)
  return {
    kind: 'rollback',
    expectedRevision: state.revision,
    changeSet: {
      kind: 'rollback',
      fromBranchId: branchId,
      atMessageId,
      newBranchId: randomUUID(),
      records: plan.logs,
      effective: plan.effective,
      context: plan.context,
    },
  }
}

/**
 * fork 规划（spec §4.4）：读取源快照并**冻结 sourceRevision**（连同 records/effective/context）
 * ——提交事务内校验源未变；不复制 todos；目标 create-only。
 */
export async function planFork(
  store: Pick<SessionStore, 'loadSession'>,
  source: { sessionId: string; branchId: string },
  newSessionId: string,
  ownership: SessionOwnership,
): Promise<{ kind: 'fork'; expectedRevision: null; changeSet: ChangeSet }> {
  const state = await store.loadSession(source.sessionId)
  if (!state) throw new SessionDataInvalidError(source.sessionId, 'source session not found')
  const branch = state.branches.find((b) => b.branchId === source.branchId)
  if (!branch) throw new SessionDataInvalidError(source.sessionId, `unknown branch: ${source.branchId}`)
  return {
    kind: 'fork',
    expectedRevision: null,
    changeSet: {
      kind: 'fork',
      newSessionId,
      source,
      sourceRevision: state.revision,
      records: [...branch.records],
      effective: [...branch.effective],
      context: structuredClone(branch.context),
      metadata: { ...state.metadata, id: newSessionId },
      ownership,
    },
  }
}
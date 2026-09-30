/**
 * compact 提交核心（issue #131；三轮评审 R19–R21）——Agent 与子代理（spawn）共用。
 *
 * 真实压缩产物（`utils/compact.ts` buildCompactedMessages）：
 *   head = [summary-user（**含摘要正文** `[Previous conversation summary]…`）,
 *           summary-assistant（"I understand…" 确认句）]
 * → **summary 记录取 head[0]**（R19：此前误取 head[1]，resume 只剩确认句）；
 *   head[1] 同为 summary-kind（不进有效用户历史；在 records/索引中防重复提交）。
 *
 * 空 kept 合法（R20）：prompt-too-long 全量压缩产物只有 summary pair——不以长度
 * 下限排除真实压缩（下限仅 pair 本身）。
 */
import type { NormalizedMessageParam } from '../providers/types.js'
import type { SessionStore } from './session-store.js'
import { WriteCoordinator } from './coordinator.js'
import { planCompact } from './plan.js'
import type { MessageRecord, NewRecord, OperationReceipt } from './types.js'

export interface CompactCommitDeps {
  store: SessionStore
  coordinator: WriteCoordinator
}

export interface CompactCommitResult {
  receipt: OperationReceipt
  /** 本次提交的新记录（含 summary pair）——调用方索引更新用 */
  newRecords: NewRecord[]
}

/**
 * 从旧 context（§2.2 单层展开）+ 压缩前后消息构造 §4.2 changeSet 并经 coordinator
 * 提交。`opts.expectedRevision` 省略时取当前快照 revision（独占写者场景）。
 * 不适用（行不存在 / post 不足 pair）→ undefined。
 */
export async function planAndCommitCompact(
  deps: CompactCommitDeps,
  sessionId: string,
  pre: readonly NormalizedMessageParam[],
  post: readonly NormalizedMessageParam[],
  opts?: { expectedRevision?: number },
): Promise<CompactCommitResult | undefined> {
  if (post.length < 2) return undefined   // 真实产物下限 = summary pair（R20）
  const state = await deps.store.loadSession(sessionId)
  if (!state) return undefined
  const branch = state.branches.find((b) => b.branchId === state.currentBranchId)
  const branchId = branch?.branchId ?? (state.currentBranchId || 'b1')
  const records = branch ? await deps.store.loadRecords(sessionId, branch.records) : []
  const committedRid = new Map<string, string>()
  const recordMap = new Map<string, MessageRecord>()
  for (const r of records) {
    if (r !== null) {
      committedRid.set(r.messageId, r.recordId)
      recordMap.set(r.recordId, r)
    }
  }
  const mid = (m: NormalizedMessageParam): string | undefined => (m as { id?: string }).id
  const head = post.slice(0, 2)
  const kept = post.slice(2)
  const keptIds = new Set(kept.map((m) => mid(m) ?? '\u0000'))
  // covers 展开自旧 context（§2.2 单层）：records 段直取；summary 段展开至 covers 原文
  const pendingRecords: NewRecord[] = []
  const coveredRids: string[] = []
  const coveredMid = new Set<string>()
  if (branch !== undefined) {
    for (const seg of branch.context.segments) {
      const rids = seg.kind === 'records' ? seg.recordIds : seg.covers.recordIds
      for (const rid of rids) {
        const r = recordMap.get(rid)
        if (!r) continue
        if (keptIds.has(r.messageId) || coveredMid.has(r.messageId)) continue
        coveredMid.add(r.messageId)
        coveredRids.push(rid)
      }
    }
  }
  // pending：内存 pre 中未提交、未保留、未覆盖的原文（首检前/本 query 新增）
  for (const m of pre) {
    const id = mid(m)
    if (id === undefined) continue
    if (keptIds.has(id) || coveredMid.has(id) || committedRid.has(id)) continue
    const nr: NewRecord = { recordId: crypto.randomUUID(), message: m, actor: { kind: 'main' } }
    pendingRecords.push(nr)
    coveredRids.push(nr.recordId)
    coveredMid.add(id)
  }
  // kept 记录 id（已提交 → 既有；未提交 → pending 新记录）
  const keptRids: string[] = []
  for (const m of kept) {
    const id = mid(m)
    if (id === undefined) continue
    const rid = committedRid.get(id)
    if (rid !== undefined) {
      keptRids.push(rid)
    } else {
      const nr: NewRecord = { recordId: crypto.randomUUID(), message: m, actor: { kind: 'main' } }
      pendingRecords.push(nr)
      keptRids.push(nr.recordId)
    }
  }
  // R19：summary 记录 = head[0]（含摘要正文）；head[1]（确认句）同为 summary-kind
  const summaryRecord: NewRecord = { recordId: crypto.randomUUID(), message: head[0]!, actor: { kind: 'sdk' }, kind: 'summary' }
  const ackRecord: NewRecord = { recordId: crypto.randomUUID(), message: head[1]!, actor: { kind: 'sdk' }, kind: 'summary' }
  const changeSet = planCompact({
    branchId,
    coveredSegments: coveredRids.length > 0 ? [{ kind: 'records' as const, recordIds: coveredRids }] : [],
    pendingRecords: [...pendingRecords, ackRecord],
    summaryRecord,
    keptSegment: { kind: 'records' as const, recordIds: keptRids },
  })
  const receipt = await deps.coordinator.execute(sessionId, {
    kind: 'compact',
    expectedRevision: opts?.expectedRevision ?? state.revision,
    changeSet,
  })
  return { receipt, newRecords: [...pendingRecords, ackRecord, summaryRecord] }
}
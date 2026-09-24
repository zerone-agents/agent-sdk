/**
 * applyChangeSet —— 变更集应用（纯函数，issue #131 SPEC §4）。
 *
 * adapter 的 commit = 事务 { 指纹/CAS 校验 + applyChangeSet + 落库 + 回执 }；
 * 应用语义以本函数为准（不同 adapter 不得实现出不同语义——App 冻结评审 #2）。
 * P1 分任务填充：T4 checkpoint 骨架 → T5–T9 逐 kind 替换（P1 末无 slice 残留）。
 */
import type { ChangeSet, ContextRef, MessageRecord, NewRecord, SessionState } from './types.js'
import type { TodoInfo } from '../types.js'
import { SessionDataInvalidError } from './errors.js'
import { foldEffective } from './algorithm.js'

export interface StoreData {
  state: SessionState
  records: Map<string, MessageRecord>
  todos: TodoInfo[]
}

export function newRecordToMessageRecord(nr: NewRecord, createdAt: string): MessageRecord {
  return {
    recordId: nr.recordId,
    messageId: (nr.message as { id?: string }).id ?? '',
    message: nr.message,
    actor: nr.actor,
    createdAt,
    kind: nr.kind ?? 'message',
  }
}

export function initialStoreData(sessionId: string, ownership: { rootSessionId: string; parentSessionId?: string; parentToolUseId?: string }, createdAt: string): StoreData {
  return {
    state: {
      sessionId,
      metadata: { id: sessionId, cwd: '', model: '', createdAt, updatedAt: createdAt, messageCount: 0 },
      branches: [],
      currentBranchId: '',
      revision: 0,
      createdAt,
      updatedAt: createdAt,
      ownership,
    },
    records: new Map(),
    todos: [],
  }
}

function findOrInitBranch(state: SessionState, branchId: string, createdAt: string): SessionState['branches'][number] {
  let branch = state.branches.find((b) => b.branchId === branchId)
  if (!branch) {
    branch = { branchId, records: [], effective: [], context: { segments: [] }, createdAt, createdByOpId: undefined }
    state.branches.push(branch)
    if (!state.currentBranchId) state.currentBranchId = branchId
  }
  return branch
}

function appendRecords(data: StoreData, newRecords: NewRecord[], createdAt: string): string[] {
  const ids: string[] = []
  for (const nr of newRecords) {
    const mr = newRecordToMessageRecord(nr, createdAt)
    if (data.records.has(mr.recordId)) {
      throw new SessionDataInvalidError(data.state.sessionId, `duplicate recordId in changeSet: ${mr.recordId}`)
    }
    data.records.set(mr.recordId, mr)
    ids.push(mr.recordId)
  }
  return ids
}

/** 把新记录引用追加进 context（末尾 records 段合并；无段则新建）。 */
function appendContextRefs(context: ContextRef, recordIds: string[]): void {
  const last = context.segments[context.segments.length - 1]
  if (last && last.kind === 'records') {
    last.recordIds.push(...recordIds)
  } else {
    context.segments.push({ kind: 'records', recordIds: [...recordIds] })
  }
}

function mustBranch(state: SessionState, branchId: string): SessionState['branches'][number] {
  const branch = state.branches.find((b) => b.branchId === branchId)
  if (!branch) throw new SessionDataInvalidError(state.sessionId, `unknown branch: ${branchId}`)
  return branch
}

export function applyChangeSet(sessionId: string, data: StoreData, changeSet: ChangeSet, meta: { committedAt: string }): StoreData {
  switch (changeSet.kind) {
    case 'checkpoint': {
      const ids = appendRecords(data, changeSet.newRecords, meta.committedAt)
      const branch = findOrInitBranch(data.state, changeSet.branchId, meta.committedAt)
      branch.records.push(...ids)
      branch.effective.push(...ids)
      if (changeSet.context) {
        branch.context = changeSet.context
      } else {
        appendContextRefs(branch.context, ids)
      }
      Object.assign(data.state.metadata, changeSet.metadataPatch ?? {})
      data.state.metadata.messageCount = branch.effective.length
      data.state.updatedAt = meta.committedAt
      return data
    }
    case 'append': {
      const ids = appendRecords(data, changeSet.newRecords, meta.committedAt)
      const branch = mustBranch(data.state, changeSet.branchId)
      branch.records.push(...ids)
      branch.effective.push(...ids)
      if (changeSet.contextAppend) appendContextRefs(branch.context, ids)
      data.state.metadata.messageCount = branch.effective.length
      data.state.updatedAt = meta.committedAt
      return data
    }
    case 'revise': {
      const [newId] = appendRecords(data, [changeSet.newRecord], meta.committedAt)
      const branch = mustBranch(data.state, changeSet.branchId)
      branch.records.push(newId)
      const idx = branch.effective.findIndex((rid) => data.records.get(rid)?.messageId === changeSet.messageId)
      if (idx === -1) {
        throw new SessionDataInvalidError(sessionId, `revise target messageId not found in effective: ${changeSet.messageId}`)
      }
      branch.effective[idx] = newId
      branch.context = changeSet.contextUpdate
      data.state.metadata.messageCount = branch.effective.length
      data.state.updatedAt = meta.committedAt
      return data
    }
    case 'compact': {
      const ids = appendRecords(data, changeSet.newRecords, meta.committedAt)
      const branch = findOrInitBranch(data.state, changeSet.branchId, meta.committedAt)
      branch.records.push(...ids)
      // effective = 折叠重算（summary 记录被排除；revise 版本语义由 fold 保证）——
      // 完整历史（UI 视图）与模型上下文分离的核心（spec §2/§4.2）
      branch.effective = foldEffective(branch.records, (rid) => data.records.get(rid))
      // 模型上下文整体替换为 [summary 段(covers), kept 段]
      branch.context = changeSet.context
      data.state.metadata.messageCount = branch.effective.length
      data.state.updatedAt = meta.committedAt
      return data
    }
    default:
      // T7–T9 逐 kind 填充；P1 末必须无残留（验收 #3）
      throw new Error(`applyChangeSet: kind "${changeSet.kind}" not implemented in P1 slice yet`)
  }
}
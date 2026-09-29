/**
 * SessionManager v2——宿主侧会话治理入口（issue #131 P3 T6）。
 *
 * 所有写操作经 WriteCoordinator（prepare → journal → commit → release，指纹冻结）；
 * 读操作直接走 store（loadSession/loadContext/loadTodos）。
 * revise 追加修订记录（append-only，折叠取最后版本）；rollback 复用 SDK 域算法
 * rebuildRollback（五步折叠重建）；fork 复制源分支为独立新会话。
 */
import type { NormalizedMessageParam } from '../providers/types.js'
import type { Branch, ContextRef, ContextSegment, MessageRecord, NewRecord, OperationReceipt, SessionState } from './types.js'
import type { SessionStore, OwnershipFilter } from './session-store.js'
import type { SessionMetadata } from '../session.js'
import type { TodoInfo } from '../types.js'
import { rebuildRollback } from './algorithm.js'
import { WriteCoordinator } from './coordinator.js'

export interface SessionManagerV2 {
  /** 读会话元数据；missing → null（三态读，不抛错） */
  get(sessionId: string): Promise<SessionState | null>
  /** 读当前分支上下文消息；missing → [] */
  getMessages(sessionId: string): Promise<NormalizedMessageParam[]>
  /** 修订消息正文（append-only：追加新版本记录，折叠后生效） */
  revise(sessionId: string, messageId: string, newContent: string): Promise<OperationReceipt>
  /** 回退到目标消息创建时刻（新分支承接截断历史） */
  rollback(sessionId: string, atMessageId: string): Promise<OperationReceipt>
  /** 复制源会话当前分支为独立新会话 */
  fork(sourceSessionId: string, newSessionId: string): Promise<OperationReceipt>
  /** 删除（tombstone）；cascadeOwned 级联删除其名下所有子会话 */
  delete(sessionId: string, cascadeOwned?: boolean): Promise<OperationReceipt>
  /** 保存 todos（经 coordinator，指纹冻结） */
  saveTodos(sessionId: string, todos: TodoInfo[]): Promise<OperationReceipt>
  /** 读 todos；missing → [] */
  getTodos(sessionId: string): Promise<TodoInfo[]>
  /** 追加消息（默认进上下文；contextAppend:false = UI-only 正文不进模型上下文） */
  append(sessionId: string, message: NormalizedMessageParam, opts?: { contextAppend?: boolean }): Promise<OperationReceipt>
  /** 列出会话元数据（可选能力——store 未实现 listSessions 时显式报错） */
  list(filter?: OwnershipFilter): Promise<SessionMetadata[]>
  /** 三态回执查询：原回执 / null（not-committed）/ 抛错（recycled——不折叠为 null） */
  getOperation(sessionId: string, operationId: string): Promise<OperationReceipt | null>
  /** 清空 todos（= saveTodos([])） */
  clearTodos(sessionId: string): Promise<OperationReceipt>
}

export interface SessionManagerV2Init {
  store: SessionStore
  coordinator?: WriteCoordinator
}

export function createSessionManagerV2(init: SessionManagerV2Init): SessionManagerV2 {
  const store = init.store
  const coordinator = init.coordinator ?? new WriteCoordinator({ store })

  /** 加载当前分支 + 记录映射（revise/rollback/fork 共用）。 */
  async function loadBranch(sessionId: string): Promise<{
    state: SessionState
    branch: Branch
    recordMap: Map<string, MessageRecord>
  }> {
    const state = await store.loadSession(sessionId)
    if (!state) throw new Error(`session not found: ${sessionId}`)
    const branch = state.branches.find((b) => b.branchId === state.currentBranchId)
    if (!branch) throw new Error(`current branch not found: ${String(state.currentBranchId)}`)
    const records = await store.loadRecords(sessionId, branch.records)
    const recordMap = new Map<string, MessageRecord>()
    for (const r of records) {
      if (r !== null) recordMap.set(r.recordId, r)
    }
    return { state, branch, recordMap }
  }

  return {
    async get(sessionId) {
      return store.loadSession(sessionId)
    },

    async getMessages(sessionId) {
      const state = await store.loadSession(sessionId)
      if (!state) return []
      return store.loadContext(sessionId, state.currentBranchId)
    },

    async revise(sessionId, messageId, newContent) {
      const { state, branch, recordMap } = await loadBranch(sessionId)
      // 评审 R3：从 **effective** 定位当前版本——logs 首现是原始版；连续 revise 时
      // context 引用的已是修订版，替换原始版 recordId 是 no-op，读回的仍是旧正文。
      const currentRecordId = branch.effective.find((rid) => recordMap.get(rid)?.messageId === messageId)
      const current = currentRecordId !== undefined ? recordMap.get(currentRecordId) : undefined
      if (currentRecordId === undefined || !current) {
        throw new Error(`message not found in effective history: ${messageId}`)
      }
      const newRecord: NewRecord = {
        recordId: crypto.randomUUID(),
        message: { ...current.message, content: newContent },
        actor: { kind: 'sdk' },
      }
      const contextUpdate = buildReviseContext(branch, currentRecordId, newRecord.recordId, messageId, recordMap)
      return coordinator.execute(sessionId, {
        kind: 'revise',
        expectedRevision: state.revision,
        changeSet: {
          kind: 'revise', branchId: branch.branchId, messageId,
          newRecord, contextUpdate,
        },
      })
    },

    async rollback(sessionId, atMessageId) {
      const { state, branch, recordMap } = await loadBranch(sessionId)
      const plan = rebuildRollback(sessionId, branch, recordMap, atMessageId)
      return coordinator.execute(sessionId, {
        kind: 'rollback',
        expectedRevision: state.revision,
        changeSet: {
          kind: 'rollback',
          fromBranchId: branch.branchId,
          atMessageId,
          newBranchId: `rb-${crypto.randomUUID().slice(0, 8)}`,
          records: plan.logs,
          effective: plan.effective,
          context: plan.context,
        },
      })
    },

    async fork(sourceSessionId, newSessionId) {
      const { state, branch } = await loadBranch(sourceSessionId)
      // commit 以**新会话 ID** 寻址（fork 目标尚不存在 → existing=null，
      // 允许 changeSet 声明新 ownership；源快照经 source 字段冻结校验）
      return coordinator.execute(newSessionId, {
        kind: 'fork',
        expectedRevision: null,
        changeSet: {
          kind: 'fork',
          newSessionId,
          source: { sessionId: sourceSessionId, branchId: branch.branchId },
          sourceRevision: state.revision,
          records: branch.records,
          effective: branch.effective,
          context: branch.context,
          metadata: {},
          ownership: { rootSessionId: newSessionId },
        },
      })
    },

    async delete(sessionId, cascadeOwned) {
      return coordinator.execute(sessionId, {
        kind: 'delete',
        ...(cascadeOwned !== undefined ? { cascadeOwned } : {}),
      })
    },

    async saveTodos(sessionId, todos) {
      return coordinator.execute(sessionId, { kind: 'save-todos', todos })
    },

    async getTodos(sessionId) {
      return store.loadTodos(sessionId)
    },

    /** 追加消息（默认进上下文；contextAppend:false = UI-only 正文不进模型上下文）。 */
    async append(sessionId, message, opts) {
      const { state, branch } = await loadBranch(sessionId)
      const newRecord: NewRecord = {
        recordId: crypto.randomUUID(),
        message,
        actor: { kind: 'sdk' },
      }
      return coordinator.execute(sessionId, {
        kind: 'append',
        expectedRevision: state.revision,
        changeSet: {
          kind: 'append', branchId: branch.branchId,
          newRecords: [newRecord],
          contextAppend: opts?.contextAppend ?? true,
        },
      })
    },

    /** 列出会话（可选能力——store 未实现 listSessions 时显式报错）。 */
    async list(filter) {
      const lister = store as SessionStore & {
        listSessions?: (f?: import('./session-store.js').OwnershipFilter) => Promise<SessionMetadata[]>
      }
      if (typeof lister.listSessions !== 'function') {
        throw new Error('store does not implement optional listSessions capability')
      }
      return lister.listSessions(filter)
    },

    /** 三态回执查询：原回执 / null（not-committed）/ 抛错（recycled——不折叠为 null）。 */
    async getOperation(sessionId, operationId) {
      return coordinator.query(sessionId, operationId)
    },

    /** 清空 todos（= saveTodos([])）。 */
    async clearTodos(sessionId) {
      return coordinator.execute(sessionId, { kind: 'save-todos', todos: [] })
    },
  }
}

/**
 * revise 上下文重建（评审 R3 / §4.5）：
 * - records 段：当前版本 recordId → 新 recordId 原位替换；
 * - 命中摘要（covers 覆盖被修订消息）：摘要失效——原位展开为 records 段
 *   （covers ∩ 新有效版本：每消息取当前 effective 版本，目标消息取新 record）。
 */
function buildReviseContext(
  branch: Branch,
  currentRecordId: string,
  newRecordId: string,
  messageId: string,
  recordMap: ReadonlyMap<string, MessageRecord>,
): ContextRef {
  // 新有效版本映射（messageId → 当前 recordId）：effective 现状 + 本次修订覆盖目标
  const effectiveMap = new Map<string, string>()
  for (const rid of branch.effective) {
    const r = recordMap.get(rid)
    if (r) effectiveMap.set(r.messageId, rid)
  }
  effectiveMap.set(messageId, newRecordId)

  const segments: ContextSegment[] = []
  for (const seg of branch.context.segments) {
    if (seg.kind === 'records') {
      segments.push({
        kind: 'records' as const,
        recordIds: seg.recordIds.map((rid) => (rid === currentRecordId ? newRecordId : rid)),
      })
      continue
    }
    // summary 段：covers 是否覆盖被修订消息（covers 持摘要时点的版本 recordId——按 messageId 判定）
    const coversMessage = seg.covers.recordIds.some((rid) => recordMap.get(rid)?.messageId === messageId)
    if (!coversMessage) {
      segments.push(seg)  // 未受影响的摘要原位保留
      continue
    }
    // §4.5 失效展开：covers → 当前有效版本记录（目标替换为新 record；去重）
    const kept: string[] = []
    for (const rid of seg.covers.recordIds) {
      const r = recordMap.get(rid)
      if (!r) continue
      const cur = effectiveMap.get(r.messageId)
      if (cur === undefined || kept.includes(cur)) continue
      kept.push(cur)
    }
    if (kept.length > 0) segments.push({ kind: 'records' as const, recordIds: kept })
  }
  return { segments }
}
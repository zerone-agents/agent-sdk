/**
 * SessionManager v2——宿主侧会话治理入口（issue #131 P3 T6）。
 *
 * 所有写操作经 WriteCoordinator（prepare → journal → commit → release，指纹冻结）；
 * 读操作直接走 store（loadSession/loadContext/loadTodos）。
 * revise 追加修订记录（append-only，折叠取最后版本）；rollback 复用 SDK 域算法
 * rebuildRollback（五步折叠重建）；fork 复制源分支为独立新会话。
 */
import type { NormalizedMessageParam } from '../providers/types.js'
import type { Branch, ContextRef, MessageRecord, NewRecord, OperationReceipt, SessionState } from './types.js'
import type { SessionStore } from './session-store.js'
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
      const target = [...recordMap.values()].find((r) => r.messageId === messageId)
      if (!target) throw new Error(`message not found: ${messageId}`)
      const newRecord: NewRecord = {
        recordId: crypto.randomUUID(),
        message: { ...target.message, content: newContent },
        actor: { kind: 'sdk' },
      }
      const contextUpdate = substituteInContext(branch.context, target.recordId, newRecord.recordId)
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
  }
}

/** revise 上下文替换：records 段中被修订 recordId → 新 recordId（summary covers 不动）。 */
function substituteInContext(ctx: ContextRef, oldRecordId: string, newRecordId: string): ContextRef {
  return {
    segments: ctx.segments.map((seg) => {
      if (seg.kind === 'records') {
        return {
          kind: 'records' as const,
          recordIds: seg.recordIds.map((rid) => (rid === oldRecordId ? newRecordId : rid)),
        }
      }
      return seg
    }),
  }
}
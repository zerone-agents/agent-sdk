/**
 * Legacy v3 档案导入编排（issue #131 P3 T7；二轮评审 R14/R15 重写）。
 *
 * 三态报告 + 恢复协议（§8.3）：
 * - imported：导入成功（含 original operationId/revision）——pending 可清除；
 * - already-exists-unknown：目标已有 transcript 或提交结果未知——无法区分「本编排的
 *   已提交」与「其他操作建的目标」，**pending 不得清除**；携带 prepared（如有）供
 *   调用方下次以 resume 恢复：先 query 三态（committed → imported；not-committed →
 *   用原 prepared 重试——同 operationId 不重复）；
 * - not-imported：未导入（档案缺失/读取失败/契约拒绝）——pending 可清除。
 *
 * skip 判定按**转录存在性**（§8.3）：register-only（有行无 transcript）不跳过，正常导入。
 * 数据完备：全量可映射 metadata（cwd/provider/tag/activatedTools/lastInputTokens…
 * 原样保留）+ legacy todos 原子随 import ChangeSet 落库；无法映射的内容进 warnings。
 */
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { loadSession as readLegacySession, type SessionData } from '../session.js'
import type { SessionStore } from './session-store.js'
import { WriteCoordinator } from './coordinator.js'
import type { NewRecord, PreparedOperation } from './types.js'
import type { TodoInfo } from '../types.js'

export type ImportReport =
  | {
    status: 'imported'
    sessionId: string
    operationId: string
    revision: number
    messageCount: number
    todoCount: number
    warnings?: string[]
  }
  | {
    status: 'already-exists-unknown'
    sessionId: string
    existingRevision: number
    /** 原 prepared（提交未知时可恢复——下次以 resume 传入；query/retry 同一操作） */
    prepared?: PreparedOperation
    reason: string
  }
  | { status: 'not-imported'; sessionId: string; reason: string }

export interface ImportLegacyOptions {
  store: SessionStore
  coordinator?: WriteCoordinator
  /** 自定义 legacy 读取器（默认 session.js 的 @deprecated loadSession——HOME 基路径） */
  legacyReader?: (sessionId: string) => Promise<SessionData | null>
  /** 自定义 legacy todos 读取器（默认 `<HOME>/.agents/sessions/<sid>/todos.json`） */
  legacyTodosReader?: (sessionId: string) => Promise<TodoInfo[] | null>
  /** 恢复协议（R14）：上次 already-exists-unknown 携带的 prepared——先 query 三态再重试 */
  resume?: PreparedOperation
}

/** v3 todos.json 默认读取器：数组缺失 → null；文件缺失 → null；损坏 → 抛出（编排转 warning）。 */
async function readLegacyTodos(sessionId: string): Promise<TodoInfo[] | null> {
  const home = process.env.HOME || process.env.USERPROFILE || '/tmp'
  const file = join(home, '.agents', 'sessions', sessionId, 'todos.json')
  let raw: string
  try {
    raw = await readFile(file, 'utf-8')
  } catch {
    return null   // 文件缺失——无 todos（正常）
  }
  const parsed = JSON.parse(raw) as { todos?: unknown }
  if (!Array.isArray(parsed.todos)) return null
  return parsed.todos as TodoInfo[]
}

/** 导入单个 legacy v3 会话档案（编排入口；三态报告 + prepared 恢复协议）。 */
export async function importLegacySession(
  init: ImportLegacyOptions,
  sessionId: string,
): Promise<ImportReport> {
  const coordinator = init.coordinator ?? new WriteCoordinator({ store: init.store })

  // ── 恢复协议（R14）：有原 prepared → 先查询其结果 ──
  if (init.resume) {
    let outcome: { status: string; receipt?: { operationId: string; revision?: number } } | null = null
    try {
      const q = await coordinator.query(sessionId, init.resume.operationId)
      outcome = q === null ? { status: 'not-committed' } : { status: 'committed', receipt: q }
    } catch {
      outcome = null   // recycled / 查询故障——无法判定，落入状态检查
    }
    if (outcome?.status === 'committed' && outcome.receipt) {
      return {
        status: 'imported',
        sessionId,
        operationId: outcome.receipt.operationId,
        revision: outcome.receipt.revision ?? 0,
        messageCount: 0,   // 原回执不含明细——调用方以 store 读为准
        todoCount: 0,
      }
    }
    if (outcome?.status === 'not-committed') {
      // 用**原 prepared**重试——同 operationId 不重复生成（spec §5）
      try {
        const receipt = await coordinator.retry(sessionId, init.resume)
        return {
          status: 'imported',
          sessionId,
          operationId: receipt.operationId,
          revision: receipt.revision ?? 0,
          messageCount: 0,
          todoCount: 0,
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'CoordinatorUnknownError') {
          const prepared = (err as { prepared?: PreparedOperation }).prepared ?? init.resume
          return {
            status: 'already-exists-unknown',
            sessionId,
            existingRevision: -1,
            prepared,
            reason: `retry outcome unknown: ${String(err)}`,
          }
        }
        return { status: 'not-imported', sessionId, reason: `retry rejected: ${String(err)}` }
      }
    }
    // 判定失败（recycled/查询故障）→ 落入状态检查（结果为 unknown 语义）
  }

  // ── skip 判定按**转录存在性**（§8.3）：register-only 不跳过 ──
  const existing = await init.store.loadSession(sessionId)
  if (existing && existing.branches.length > 0) {
    return {
      status: 'already-exists-unknown',
      sessionId,
      existingRevision: existing.revision,
      ...(init.resume ? { prepared: init.resume } : {}),
      reason: 'target has a transcript — cannot distinguish own committed import from another operation',
    }
  }

  // ── 读取 legacy 档案与 todos ──
  let legacy: SessionData | null
  try {
    legacy = await (init.legacyReader ?? readLegacySession)(sessionId)
  } catch (err) {
    return { status: 'not-imported', sessionId, reason: `legacy archive read failed: ${String(err)}` }
  }
  if (!legacy) {
    return { status: 'not-imported', sessionId, reason: 'legacy archive not found' }
  }
  const warnings: string[] = []
  let todos: TodoInfo[] | null = null
  try {
    todos = await (init.legacyTodosReader ?? readLegacyTodos)(sessionId)
  } catch (err) {
    warnings.push(`legacy todos unreadable: ${String(err)}`)
  }

  // ── 物化记录：按 messageId 去重（折叠取最后版本；ensureMessageIds 保证 id）──
  const seen = new Set<string>()
  const newRecords: NewRecord[] = []
  for (const message of legacy.messages) {
    const mid = (message as { id?: string }).id
    if (mid === undefined || seen.has(mid)) continue
    seen.add(mid)
    newRecords.push({ recordId: randomUUID(), message, actor: { kind: 'sdk' } })
  }
  const recordIds = newRecords.map((r) => r.recordId)

  // ── 全量可映射 metadata（R15）：剔除非映射字段（id/updatedAt/messageCount/revision）──
  const { id: _id, updatedAt: _updatedAt, messageCount: _messageCount, revision: _revision, ...mappable } = legacy.metadata

  const ownership = existing?.ownership ?? { rootSessionId: sessionId }
  // §8.3：import 是 create-only（按转录存在性判定——register-only 行亦通过）
  const expectedRevision = null

  try {
    const receipt = await coordinator.execute(sessionId, {
      kind: 'import',
      expectedRevision,
      changeSet: {
        kind: 'import',
        // register 行的 currentBranchId 为空串——`|| 'b1'` 规范化为 canonical 分支 id
        branchId: existing?.currentBranchId || 'b1',
        newRecords,
        effective: recordIds,
        context: { segments: [{ kind: 'records', recordIds }] },
        metadata: mappable,
        ownership,
        initialRevision: legacy.metadata.revision ?? 0,
        ...(todos !== null && todos.length > 0 ? { todos } : {}),
      },
    })
    return {
      status: 'imported',
      sessionId,
      operationId: receipt.operationId,
      revision: receipt.revision ?? 0,
      messageCount: newRecords.length,
      todoCount: todos?.length ?? 0,
      ...(warnings.length > 0 ? { warnings } : {}),
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'CoordinatorUnknownError') {
      return {
        status: 'already-exists-unknown',
        sessionId,
        existingRevision: existing?.revision ?? -1,
        prepared: (err as { prepared?: PreparedOperation }).prepared,
        reason: `import outcome unknown: ${String(err)}`,
      }
    }
    return { status: 'not-imported', sessionId, reason: `import rejected: ${String(err)}` }
  }
}

export interface ImportArchiveReport {
  reports: ImportReport[]
  imported: number
  alreadyExistsUnknown: number
  notImported: number
}

/**
 * 批量导入整个 legacy archive（R15）：扫描 `<baseDir ?? HOME/.agents/sessions>`，
 * 逐会话导入；逐项报告 + 汇总计数（无损映射报告——不可映射内容在各项 warnings）。
 */
export async function importLegacyArchive(
  init: ImportLegacyOptions,
  opts?: { baseDir?: string },
): Promise<ImportArchiveReport> {
  const home = process.env.HOME || process.env.USERPROFILE || '/tmp'
  const baseDir = opts?.baseDir ?? join(home, '.agents', 'sessions')
  let entries: string[]
  try {
    entries = await readdir(baseDir)
  } catch {
    return { reports: [], imported: 0, alreadyExistsUnknown: 0, notImported: 0 }
  }
  const reports: ImportReport[] = []
  for (const sid of entries) {
    reports.push(await importLegacySession(init, sid))
  }
  return {
    reports,
    imported: reports.filter((r) => r.status === 'imported').length,
    alreadyExistsUnknown: reports.filter((r) => r.status === 'already-exists-unknown').length,
    notImported: reports.filter((r) => r.status === 'not-imported').length,
  }
}
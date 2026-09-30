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
import { prepareOperation } from './prepare.js'
import { SessionConflictError } from './errors.js'
import type { NewRecord, PreparedOperation, OperationReceipt } from './types.js'
import type { TodoInfo } from '../types.js'

/** CoordinatorUnknownError 识别（提交结果未知——携原 prepared）。 */
function isUnknownOutcome(err: unknown): boolean {
  return err instanceof Error && err.name === 'CoordinatorUnknownError'
}

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

/**
 * v3 todos.json 默认读取器（R24 严格语义）：**仅 ENOENT 视为无 todos**（null）；
 * 权限等其他文件错误、解析失败、结构错误（缺 todos 数组）一律上抛——编排阻止提交。
 */
async function readLegacyTodos(sessionId: string): Promise<TodoInfo[] | null> {
  const home = process.env.HOME || process.env.USERPROFILE || '/tmp'
  const file = join(home, '.agents', 'sessions', sessionId, 'todos.json')
  let raw: string
  try {
    raw = await readFile(file, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  const parsed = JSON.parse(raw) as { todos?: unknown }
  if (!Array.isArray(parsed.todos)) {
    throw new Error('legacy todos.json exists but has no todos array (structure error)')
  }
  return parsed.todos as TodoInfo[]
}

/** 导入单个 legacy v3 会话档案（编排入口；三态报告 + prepared 恢复协议）。 */
export async function importLegacySession(
  init: ImportLegacyOptions,
  sessionId: string,
): Promise<ImportReport> {
  const coordinator = init.coordinator ?? new WriteCoordinator({ store: init.store })

  // ── 恢复协议（R14/R23）：有原 prepared → 先查询其结果（三态）──
  if (init.resume) {
    let outcome: 'committed' | 'not-committed' | 'indeterminate'
    let committedReceipt: OperationReceipt | undefined
    try {
      const q = await coordinator.query(sessionId, init.resume.operationId)
      if (q === null) {
        outcome = 'not-committed'
      } else {
        outcome = 'committed'
        committedReceipt = q
      }
    } catch {
      outcome = 'indeterminate'   // recycled / 查询故障——无法判定
    }
    if (outcome === 'committed' && committedReceipt) {
      return {
        status: 'imported',
        sessionId,
        operationId: committedReceipt.operationId,
        revision: committedReceipt.revision ?? 0,
        messageCount: 0,   // 原回执不含明细——调用方以 store 读为准
        todoCount: 0,
      }
    }
    if (outcome === 'indeterminate') {
      // R23①：查询不确定**必须终止于 unknown**——不得重新 prepare/execute 新操作
      return {
        status: 'already-exists-unknown',
        sessionId,
        existingRevision: -1,
        prepared: init.resume,
        reason: 'original operation outcome could not be determined (recycled or query failure) — recovery handle preserved',
      }
    }
    // not-committed → 用**原 prepared**重试（同 operationId，不重新生成——spec §5）
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
      if (err instanceof SessionConflictError) {
        // R23②：create-only 冲突 = 其他操作已创建目标——按契约 already-exists-unknown
        return {
          status: 'already-exists-unknown',
          sessionId,
          existingRevision: -1,
          prepared: init.resume,
          reason: `retry hit a create-only conflict (target created concurrently): ${String(err)}`,
        }
      }
      if (isUnknownOutcome(err)) {
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
  // R24：todos 读取/结构故障**阻止提交**——不得当作完整 imported（否则 transcript
  // 已存在、无法补导 todos）。未提交任何操作——修复档案后可直接重跑。
  let todos: TodoInfo[] | null = null
  try {
    todos = await (init.legacyTodosReader ?? readLegacyTodos)(sessionId)
  } catch (err) {
    return {
      status: 'not-imported',
      sessionId,
      reason: `legacy todos unreadable — import blocked (nothing committed, safe to retry after fixing): ${String(err)}`,
    }
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

  // R23：编排侧 prepare（operationId 可知——首次冲突与 unknown 均可携带恢复句柄）
  const prepared = prepareOperation(sessionId, {
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
  try {
    const receipt = await coordinator.retry(sessionId, prepared)
    return {
      status: 'imported',
      sessionId,
      operationId: receipt.operationId,
      revision: receipt.revision ?? 0,
      messageCount: newRecords.length,
      todoCount: todos?.length ?? 0,
    }
  } catch (err) {
    if (err instanceof SessionConflictError) {
      // R23：首次 create-only 冲突 = 目标被并发创建——按契约 already-exists-unknown
      return {
        status: 'already-exists-unknown',
        sessionId,
        existingRevision: existing?.revision ?? -1,
        prepared,
        reason: `create-only conflict (target created concurrently): ${String(err)}`,
      }
    }
    if (isUnknownOutcome(err)) {
      return {
        status: 'already-exists-unknown',
        sessionId,
        existingRevision: existing?.revision ?? -1,
        prepared: (err as { prepared?: PreparedOperation }).prepared ?? prepared,
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
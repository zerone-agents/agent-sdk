/**
 * Legacy v3 档案导入编排（issue #131 P3 T7；评审 R10 补齐）。
 *
 * 三态报告（ImportReport）：
 * - imported：目标不存在且 legacy 档案读取成功——单次 import 原子落库
 *   （记录 + effective + context + metadata + ownership + initialRevision）；
 * - skipped：目标会话已存在——幂等跳过（不重写既有会话，附 existingRevision）；
 * - failed：legacy 档案缺失或读取失败——报告原因，不抛错（批量迁移可继续）。
 */
import { randomUUID } from 'node:crypto'
import { loadSession as readLegacySession, type SessionData } from '../session.js'
import type { SessionStore } from './session-store.js'
import { WriteCoordinator } from './coordinator.js'
import type { NewRecord } from './types.js'

export type ImportReport =
  | { status: 'imported'; sessionId: string; operationId: string; revision: number; messageCount: number }
  | { status: 'skipped'; sessionId: string; reason: 'already-exists'; existingRevision: number }
  | { status: 'failed'; sessionId: string; reason: string }

export interface ImportLegacyOptions {
  store: SessionStore
  coordinator?: WriteCoordinator
  /** 自定义 legacy 读取器（默认 session.js 的 @deprecated loadSession——HOME 基路径） */
  legacyReader?: (sessionId: string) => Promise<SessionData | null>
}

/** 导入单个 legacy v3 会话档案（编排入口；三态报告，读取失败不抛错）。 */
export async function importLegacySession(
  init: ImportLegacyOptions,
  sessionId: string,
): Promise<ImportReport> {
  const coordinator = init.coordinator ?? new WriteCoordinator({ store: init.store })
  // 幂等跳过：目标已存在——绝不重写既有会话
  const existing = await init.store.loadSession(sessionId)
  if (existing) {
    return { status: 'skipped', sessionId, reason: 'already-exists', existingRevision: existing.revision }
  }
  let legacy: SessionData | null
  try {
    legacy = await (init.legacyReader ?? readLegacySession)(sessionId)
  } catch (err) {
    return { status: 'failed', sessionId, reason: `legacy archive read failed: ${String(err)}` }
  }
  if (!legacy) {
    return { status: 'failed', sessionId, reason: 'legacy archive not found' }
  }
  // 物化记录：按 messageId 去重（折叠语义取最后版本；legacy ensureMessageIds 已保证 id）
  const seen = new Set<string>()
  const newRecords: NewRecord[] = []
  for (const message of legacy.messages) {
    const mid = (message as { id?: string }).id
    if (mid === undefined || seen.has(mid)) continue
    seen.add(mid)
    newRecords.push({ recordId: randomUUID(), message, actor: { kind: 'sdk' } })
  }
  const recordIds = newRecords.map((r) => r.recordId)
  const receipt = await coordinator.execute(sessionId, {
    kind: 'import',
    expectedRevision: null,
    changeSet: {
      kind: 'import',
      branchId: 'b1',
      newRecords,
      effective: recordIds,
      context: { segments: [{ kind: 'records', recordIds }] },
      metadata: {
        model: legacy.metadata.model,
        createdAt: legacy.metadata.createdAt,
        ...(legacy.metadata.summary !== undefined ? { summary: legacy.metadata.summary } : {}),
      },
      ownership: { rootSessionId: sessionId },
      initialRevision: legacy.metadata.revision ?? 0,
    },
  })
  return {
    status: 'imported',
    sessionId,
    operationId: receipt.operationId,
    revision: receipt.revision ?? 0,
    messageCount: newRecords.length,
  }
}
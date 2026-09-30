/**
 * Session types + legacy v3 reader
 *
 * v4（issue #131）：会话持久化统一走 SessionStore（`./store`，WriteCoordinator
 * 编排）。本模块仅保留 SessionMetadata / SessionData 公开类型与 @deprecated
 * loadSession——读取 legacy v3 磁盘格式（~/.agents/sessions/<sid>/transcript.json），
 * 仅供导入工具迁移旧档案；新代码一律走 SessionStore。
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { SessionDataInvalidError } from './store/errors.js'
import type { NormalizedMessageParam } from './providers/types.js'

/**
 * Session metadata.
 */
export interface SessionMetadata {
  id: string
  cwd: string
  model: string
  provider?: string
  createdAt: string
  updatedAt: string
  messageCount: number
  summary?: string
  lastInputTokens?: number
  lastOutputTokens?: number
  /** FindTool-activated deferred tool names (issue #115). Optional: sessions
   * saved by older SDK versions have no such field. */
  activatedTools?: string[]
  /** 会话标签（tagSession）。原为 as any 写入，issue #4 正式入型。 */
  tag?: string | null
  /** 乐观并发版本号，单调递增。仅 CAS 写路径写入；legacy 路径不写。 */
  revision?: number
}

/**
 * Session data on disk.
 */
export interface SessionData {
  metadata: SessionMetadata
  messages: NormalizedMessageParam[]
}

/**
 * Load a legacy (v3) session from disk.
 *
 * @deprecated v3 格式读取器——仅供导入工具迁移旧档案；新代码用 SessionStore
 *（`@zerone-agent/agent-sdk/store`）。v4 迁移：SessionManagerV2 的 import 入口。
 */
export async function loadSession(sessionId: string): Promise<SessionData | null> {
  const home = process.env.HOME || process.env.USERPROFILE || '/tmp'
  const file = join(home, '.agents', 'sessions', sessionId, 'transcript.json')
  let raw: string
  try {
    raw = await readFile(file, 'utf-8')
  } catch {
    return null  // 文件不存在或不可读 → null（与 v3 FileSessionStorage.load 语义一致）
  }
  const data = JSON.parse(raw) as SessionData
  if (typeof data !== 'object' || typeof data.metadata !== 'object' || data.metadata === null
    || !Array.isArray(data.messages)) {
    throw new SessionDataInvalidError(sessionId, 'malformed SessionData: metadata object and messages array required')
  }
  if (data.metadata.id !== sessionId) {
    throw new SessionDataInvalidError(sessionId, `metadata.id mismatch: stored ${String(data.metadata.id)}`)
  }
  for (const msg of data.messages) {
    if (!msg.id) msg.id = randomUUID()
  }
  return data
}
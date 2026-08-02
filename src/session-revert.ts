/**
 * Session-level revert
 *
 * Reverts a persisted session by reading transcript.json, rolling back files
 * via SnapshotEngine, truncating messages at the anchor message, and writing
 * the updated transcript back to disk.
 *
 * This is intentionally stateless: there is no in-memory revert state and no
 * undo. After revert, the session file is the source of truth. Callers that
 * need an undo path should fork the session before reverting.
 */

import type { NormalizedMessageParam } from './providers/types.js'
import { SnapshotEngine } from './snapshot/index.js'
import { loadSession, saveSession } from './session.js'

export interface RevertSessionOptions {
  /** Working directory for file revert. Defaults to process.cwd(). */
  cwd?: string
  /** Optional pre-initialized SnapshotEngine. Created lazily if needed. */
  snapshotEngine?: SnapshotEngine
}

export interface RevertResult {
  /** The message ID used as the revert anchor. */
  messageId: string
  /** Files that were changed between the anchor and the session tail. */
  changedFiles: string[]
  /** Optional diff text (Mode A only). */
  diff?: string
}

interface RevertEntry {
  hash: string
  path: string
}

/**
 * Find the first message id that is still available after auto-compaction.
 *
 * Returns undefined if no compaction boundary exists.
 */
function detectCompactBoundary(messages: NormalizedMessageParam[]): string | undefined {
  // Compact summaries are represented by assistant messages whose content is a
  // single text block starting with a summary marker. The first real message
  // after such a summary is the compaction boundary.
  let sawCompactSummary = false
  for (const msg of messages) {
    if (msg.role === 'assistant' && typeof msg.content !== 'string') {
      const text = msg.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('')
      if (text.startsWith('[之前的对话已压缩')) {
        sawCompactSummary = true
        continue
      }
    }
    if (sawCompactSummary && msg.id) {
      return msg.id
    }
  }
  return undefined
}

/**
 * Revert a session to before the given message.
 *
 * - Reads the session from disk.
 * - In Mode A (snapshotEngine provided / auto-created with git): restores
 *   files changed on or after the anchor message to their pre-anchor state.
 * - Truncates messages at the anchor message (anchor excluded).
 * - Writes the updated transcript back to disk.
 *
 * The next `createAgent({ resume })` will load the reverted transcript.
 */
export async function revertSession(
  sessionId: string,
  messageId: string,
  opts: RevertSessionOptions = {},
): Promise<RevertResult> {
  const data = await loadSession(sessionId)
  if (!data) {
    throw new Error(`Session not found: ${sessionId}`)
  }

  const anchorIdx = data.messages.findIndex((m) => m.id === messageId)
  if (anchorIdx === -1) {
    const boundary = detectCompactBoundary(data.messages)
    if (boundary) {
      throw new Error(
        `Cannot revert to message ${messageId} — it was summarized by auto-compaction. ` +
          `Earliest available message: ${boundary}`,
      )
    }
    throw new Error(`Message not found: ${messageId}`)
  }

  // Find the anchor user message's snapshot (the state before this query ran).
  const anchorMsg = data.messages[anchorIdx]
  const anchorSnap = (anchorMsg as any)._snapshot as { beforeHash: string } | undefined

  // Collect file changes from the anchor's beforeHash to current workspace state.
  const entries: RevertEntry[] = []
  const changedFiles: string[] = []

  let snapshotEngine = opts.snapshotEngine
  const cwd = opts.cwd ?? process.cwd()

  if (anchorSnap?.beforeHash) {
    if (!snapshotEngine) {
      snapshotEngine = new SnapshotEngine({ worktree: cwd })
      await snapshotEngine.init()
    }

    // Diff anchor's beforeHash against current workspace to find changed files.
    const diffText = await snapshotEngine.diff(anchorSnap.beforeHash)
    const diffFiles = diffText
      .split('\n')
      .filter((line) => line.startsWith('diff --git'))
      .map((line) => {
        const match = line.match(/^diff --git a\/(.+) b\/(.+)$/)
        return match ? match[2] : ''
      })
      .filter(Boolean)

    for (const file of diffFiles) {
      changedFiles.push(file)
      entries.push({ hash: anchorSnap.beforeHash, path: file })
    }
  }

  let diff: string | undefined
  if (snapshotEngine && entries.length > 0) {
    await snapshotEngine.revert(entries)
    diff = await snapshotEngine.diff(anchorSnap!.beforeHash)
  }

  // Truncate messages at the anchor (anchor excluded).
  const truncated = data.messages.slice(0, anchorIdx)

  // Update metadata and persist.
  const metadata = {
    ...data.metadata,
    messageCount: truncated.length,
    lastInputTokens: 0,
    lastOutputTokens: 0,
  }
  delete (metadata as any).revert

  await saveSession(sessionId, truncated, metadata)

  return {
    messageId,
    changedFiles,
    diff,
  }
}

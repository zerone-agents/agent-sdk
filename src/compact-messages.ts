/**
 * Safe, storage-agnostic conversation compaction.
 *
 * This is the public seam for hosts that own transcript persistence. It
 * preserves the recent conversation tail and returns the complete coherent
 * result that callers must persist together.
 */

import type { LLMProvider, NormalizedMessageParam } from './providers/types.js'
import type { SDKCompactMessage } from './types.js'
import {
  compactConversationWithProtectedTail,
  PRUNE_PROTECTED_TURNS,
  type AutoCompactState,
} from './utils/compact.js'

export interface CompactMessagesOptions {
  provider: LLMProvider
  model: string
  messages: NormalizedMessageParam[]
  state: AutoCompactState
  /** Number of recent user turns to preserve verbatim. */
  protectedTurns?: number
}

export interface CompactMessagesResult {
  summary: string
  compacted: boolean
  messages: NormalizedMessageParam[]
  state: AutoCompactState
}

/**
 * Compact in-memory messages while preserving the recent conversation tail.
 *
 * Callers with custom storage must persist `messages` and `state` from the
 * returned result as one coherent update. On failure, the original messages
 * and unchanged token counters are returned with `compacted: false`.
 */
export async function* compactMessagesStream(
  opts: CompactMessagesOptions,
): AsyncGenerator<SDKCompactMessage, CompactMessagesResult> {
  const result = yield* compactConversationWithProtectedTail(
    opts.provider,
    opts.model,
    opts.messages,
    opts.state,
    opts.protectedTurns ?? PRUNE_PROTECTED_TURNS,
  )

  if (result.summary.length === 0) {
    return {
      summary: '',
      compacted: false,
      messages: opts.messages,
      state: result.state,
    }
  }

  return {
    summary: result.summary,
    compacted: true,
    messages: result.messages,
    state: result.state,
  }
}

/** Non-streaming convenience wrapper for {@link compactMessagesStream}. */
export async function compactMessages(
  opts: CompactMessagesOptions,
): Promise<CompactMessagesResult> {
  const stream = compactMessagesStream(opts)
  while (true) {
    const next = await stream.next()
    if (next.done) return next.value
  }
}

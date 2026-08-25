/**
 * Session-level compact-and-persist API (issue #46).
 *
 * Hosts that hold only a persisted `sessionId` can compact safely without
 * re-implementing the lifecycle — this module owns load → protected-tail
 * compact → persist.
 *
 * Semantics (identical to `Agent.compactStream()`):
 * - summarizes older history while preserving the most recent turns verbatim
 *   (default protected-turn count: PRUNE_PROTECTED_TURNS)
 * - on success, persists messages + summary + messageCount + token counters
 *   as ONE coherent update (token counters reset to 0 by compaction, which
 *   prevents an immediate re-compact on resume)
 * - on provider failure, generator cancellation, or unsuccessful compaction,
 *   the persisted transcript and usage metadata are left unchanged
 *
 * CONCURRENCY: the SDK performs a read-modify-write on the session file with
 * no cross-request locking. Hosts MUST prevent concurrent writes to the same
 * sessionId (e.g. a per-session mutex / queue); concurrent compaction or
 * compaction racing a live Agent on the same session may lose updates.
 */

import type { LLMProvider, NormalizedMessageParam } from './providers/types.js'
import type { SDKCompactMessage } from './types.js'
import { loadSession, saveSession } from './session.js'
import { compactMessagesStream } from './compact-messages.js'
import { PRUNE_PROTECTED_TURNS, type AutoCompactState } from './utils/compact.js'

/** Options for {@link compactSessionStream}. */
export interface CompactSessionOptions {
  /** Persisted session to compact. */
  sessionId: string
  /** LLM provider used to generate the summary. */
  provider: LLMProvider
  /**
   * Model used for the summarization request ONLY. Defaults to the model
   * recorded in the session metadata. Never persisted: the session's active
   * model (metadata.model) is preserved as-is, so compacting with a cheaper
   * model does not change what the session resumes with.
   */
  model?: string
  /**
   * Number of most recent user turns (plus the final message) preserved
   * verbatim. Defaults to PRUNE_PROTECTED_TURNS — the same default as
   * `Agent.compactStream()`.
   */
  protectedTurns?: number
}

/** Final result of a session-level compaction. */
export interface CompactSessionResult {
  /** Generated summary text ('' when compaction was unsuccessful). */
  summary: string
  /** True when compaction succeeded and the session was persisted. */
  compacted: boolean
  /** Post-compaction messages (original messages when unsuccessful). */
  messages: NormalizedMessageParam[]
  /** Token counters that were persisted alongside the messages. */
  state: AutoCompactState
}

/**
 * Compact a persisted SDK session by `sessionId` — no Agent instance required.
 *
 * Streams the same start/progress/end `compact` events as the other
 * compaction interfaces. See the module docblock for semantics and the host
 * locking requirement.
 *
 * @throws when the session does not exist or cannot be read.
 */
export async function* compactSessionStream(
  opts: CompactSessionOptions,
): AsyncGenerator<SDKCompactMessage, CompactSessionResult> {
  const { sessionId, provider } = opts

  // Load the persisted session (throws to the caller when missing/unreadable
  // — nothing to compact and nothing to persist).
  const session = await loadSession(sessionId)
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`)
  }

  const model = opts.model ?? session.metadata.model
  const protectedTurns = opts.protectedTurns ?? PRUNE_PROTECTED_TURNS

  // Seed the compaction state from persisted usage so the summarizer sees the
  // same starting conditions as an Agent-based compaction of this session.
  const state: AutoCompactState = {
    compacted: false,
    turnCounter: 0,
    consecutiveFailures: 0,
    lastInputTokens: session.metadata.lastInputTokens ?? 0,
    lastOutputTokens: session.metadata.lastOutputTokens ?? 0,
  }

  // Direct `yield*` delegation: events flow out one-for-one, and cancellation
  // (.return() on the public stream) propagates through
  // compactMessagesStream → the provider generator (its finally cleanup
  // runs) before persistence — the
  // persisted session is never touched in that path.
  const result = yield* compactMessagesStream({
    provider,
    model,
    messages: session.messages,
    state,
    protectedTurns,
  })

  // Unsuccessful compaction (provider failure surfaced by the underlying
  // generator as an empty summary): leave the persisted transcript and usage
  // metadata unchanged.
  if (!result.compacted) {
    return {
      summary: '',
      compacted: false,
      messages: session.messages,
      state,
    }
  }

  // Persist ONE coherent update: compacted messages, summary, recomputed
  // messageCount (derived by saveSession), and the post-compaction token
  // counters (0/0 — this is what prevents an immediate re-compact on resume).
  // createdAt/cwd/model/provider remain from the existing metadata where
  // still valid. NB: the session's active model is metadata.model — opts.model
  // is used ONLY for the summarization request and must not leak into the
  // persisted metadata (a host compacting with a cheaper model must not
  // silently change the model the session resumes with).
  await saveSession(sessionId, result.messages, {
    cwd: session.metadata.cwd,
    model: session.metadata.model,
    provider: session.metadata.provider,
    createdAt: session.metadata.createdAt,
    summary: result.summary,
    lastInputTokens: result.state.lastInputTokens,
    lastOutputTokens: result.state.lastOutputTokens,
  })

  return {
    summary: result.summary,
    compacted: true,
    messages: result.messages,
    state: result.state,
  }
}

/**
 * Non-streaming convenience wrapper for {@link compactSessionStream}.
 * Consumes the event stream and returns the final result.
 */
export async function compactSession(
  opts: CompactSessionOptions,
): Promise<CompactSessionResult> {
  const stream = compactSessionStream(opts)
  while (true) {
    const next = await stream.next()
    if (next.done) return next.value
  }
}

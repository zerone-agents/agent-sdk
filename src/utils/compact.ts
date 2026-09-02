/**
 * Context Compression / Auto-Compaction
 *
 * Summarizes long conversation histories when context window fills up.
 * Three-tier system:
 * 1. Pruning: replace old large tool results with placeholder
 * 2. Auto-compact: triggered when tokens exceed threshold
 * 3. Micro-compact: cache-aware per-request optimization
 */

import type { LLMProvider } from '../providers/types.js'
import type { NormalizedMessageParam } from '../providers/types.js'
import type { SDKCompactMessage } from '../types.js'
import {
  getAutoCompactThreshold,
} from './tokens.js'
import { isUserQuery } from './session-queries.js'

export const PRUNE_PROTECTED_QUERIES = 4

/** Recent queries that keep full tool_result payloads at compaction time
 *  (nested inside the protectedQueries-wide verbatim tail; see spec v4 §4). */
export const TOOL_PROTECTED_QUERIES = 2
export const PRUNE_THRESHOLD_CHARS = 20_000

/**
 * Tool names whose results should never be truncated or pruned.
 * Skill instructions must persist in full for the duration of the conversation.
 */
export const PROTECTED_TOOL_NAMES = new Set<string>(['Skill'])

/**
 * Start index of the protected window = the index of the `queries`-th-from-last
 * real query start — counted with the SHARED isUserQuery (imported from
 * session-queries: pure tool_result wrappers do NOT count; a pending user
 * query DOES (accepted variance, spec v4 §4); a MIXED [text, tool_result]
 * message DOES count as a query start, spec v4.2 §1.1). Protected range
 * is [boundary, length); clearable is [0, boundary). PRECEDENCE (spec v4.1 §1):
 * the queries <= 0 check runs FIRST — 0 means fully clearable even when the
 * window has no real queries; only then does no-queries/queries >= count → 0
 * (everything protected) apply. Shared by pruneMessages and the compaction
 * window so all "last N queries" decisions agree on the same range semantics
 * (P0 fix).
 */
export function computeProtectedBoundary(messages: any[], queries: number): number {
  if (queries <= 0) return messages.length
  const queryStarts: number[] = []
  for (let i = 0; i < messages.length; i++) {
    if (isUserQuery(messages[i])) queryStarts.push(i)
  }
  if (queryStarts.length === 0 || queries >= queryStarts.length) return 0
  return queryStarts[queryStarts.length - queries]
}

/**
 * Build a lookup map from tool_use_id → tool_name by scanning
 * assistant messages for tool_use blocks.
 */
function buildToolNameMap(messages: any[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_use' && block.id && block.name) {
          map.set(block.id, block.name)
        }
      }
    }
  }
  return map
}

export interface AutoCompactState {
  compacted: boolean
  turnCounter: number
  consecutiveFailures: number
  lastInputTokens: number
  lastOutputTokens: number
}

export function createAutoCompactState(): AutoCompactState {
  return {
    compacted: false,
    turnCounter: 0,
    consecutiveFailures: 0,
    lastInputTokens: 0,
    lastOutputTokens: 0,
  }
}

export function shouldAutoCompact(
  state: AutoCompactState,
  model: string,
  contextWindow?: number,
): boolean {
  if (state.consecutiveFailures >= 3) return false
  if (state.lastInputTokens <= 0) return false

  const threshold = getAutoCompactThreshold(model, contextWindow)
  const conversationTokens = state.lastInputTokens + state.lastOutputTokens

  return conversationTokens >= threshold
}

/**
 * Compact conversation by summarizing with the LLM.
 *
 * Sends the entire conversation to the LLM for summarization,
 * then replaces the history with a compact summary.
 */
const COMPACT_SYSTEM_PROMPT = `You are a conversation summarizer. When constructing the summary, stick to this template:

## Goal
[What goal(s) is the user trying to accomplish?]

## Instructions
- [What important instructions did the user give you that are relevant]
- [If there is a plan or spec, include information about it so next agent can continue using it]

## Discoveries
[What notable things were learned during this conversation that would be useful for the next agent to know when continuing the work]

## Accomplished
[What work has been completed, what work is still in progress, and what work is left?]

## Relevant files / directories
[Construct a structured list of relevant files that have been read, edited, or created that pertain to the task at hand. If all the files in a directory are relevant, include the path to the directory.]

The summary should allow the conversation to continue seamlessly.`

function buildCompactedMessages(summary: string): NormalizedMessageParam[] {
  // Both halves of the synthetic summary pair share ONE compaction timestamp
  // (issue #54): they represent a single logical event — the compaction.
  const compactedAt = new Date().toISOString()
  return [
    {
      role: 'user',
      id: crypto.randomUUID(),
      timestamp: compactedAt,
      content: `[Previous conversation summary]\n\n${summary}\n\n[End of summary - conversation continues below]`,
    },
    {
      role: 'assistant',
      id: crypto.randomUUID(),
      timestamp: compactedAt,
      content: 'I understand the context from the previous conversation. I\'ll continue from where we left off.',
    },
  ]
}

export interface CompactResult {
  compactedMessages: NormalizedMessageParam[]
  summary: string
  state: AutoCompactState
}

/**
 * INTERNAL all-input compaction primitive.
 *
 * Semantics to be aware of before calling:
 * - Summarizes EVERY message supplied to it. It does NOT preserve a recent
 *   message tail on its own — passing a complete transcript here replaces the
 *   whole conversation with the synthetic summary pair. To keep recent queries
 *   verbatim, route it through the protected-tail wrapper. Public callers use
 *   `compactMessagesStream()` or the session-level `compactSessionStream()`.
 * - Does NOT persist anything. Callers own persistence and must write the
 *   complete `CompactResult` — `compactedMessages`, `summary`, AND `state`
 *   (including the reset `lastInputTokens`/`lastOutputTokens`) — as one
 *   coherent update. Persisting messages without the token counters causes
 *   an immediate repeated compaction on the next resume.
 *
 * This function is intentionally not exported from the package root. Public
 * callers should use `compactMessagesStream()` for custom storage or
 * `compactSessionStream()` for SDK-managed sessions.
 */
export async function* compactConversationStream(
  provider: LLMProvider,
  model: string,
  messages: any[],
  state: AutoCompactState,
  debug?: boolean,
): AsyncGenerator<SDKCompactMessage, CompactResult> {
  yield { type: 'compact', phase: 'start' }

  try {
    const strippedMessages = stripImagesFromMessages(messages)
    const compactionPrompt = buildCompactionPrompt(strippedMessages)
    const requestParams = {
      model,
      maxTokens: 8192,
      system: COMPACT_SYSTEM_PROMPT,
      messages: [{ role: 'user' as const, content: compactionPrompt }],
    }

    if (debug) {
      yield {
        type: 'compact' as const,
        phase: 'progress' as const,
        text: `\n[DEBUG] === COMPACT INPUT ===\n[DEBUG] System prompt:\n${COMPACT_SYSTEM_PROMPT}\n[DEBUG] Messages count: ${messages.length}\n[DEBUG] Compaction prompt length: ${compactionPrompt.length.toLocaleString()} chars\n[DEBUG] === COMPACT PROMPT START ===\n${compactionPrompt}\n[DEBUG] === COMPACT PROMPT END ===\n`,
      }
    }

    let summary = ''

    if (provider.createMessageStream) {
      for await (const chunk of provider.createMessageStream(requestParams)) {
        if (chunk.type === 'text' && chunk.delta) {
          summary += chunk.delta
          yield { type: 'compact', phase: 'progress', text: chunk.delta }
        }
      }
    } else {
      const response = await provider.createMessage(requestParams)
      summary = response.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { type: 'text'; text: string }).text)
        .join('\n')
    }

    yield { type: 'compact', phase: 'end', summary }

    return {
      compactedMessages: buildCompactedMessages(summary),
      summary,
      state: {
        compacted: true,
        turnCounter: state.turnCounter,
        consecutiveFailures: 0,
        lastInputTokens: 0,
        lastOutputTokens: 0,
      },
    }
  } catch (err: any) {
    yield { type: 'compact', phase: 'end', summary: '' }
    return {
      compactedMessages: messages as NormalizedMessageParam[],
      summary: '',
      state: {
        ...state,
        consecutiveFailures: state.consecutiveFailures + 1,
      },
    }
  }
}

export async function compactConversation(
  provider: LLMProvider,
  model: string,
  messages: any[],
  state: AutoCompactState,
): Promise<CompactResult> {
  try {
    const strippedMessages = stripImagesFromMessages(messages)
    const compactionPrompt = buildCompactionPrompt(strippedMessages)

    const response = await provider.createMessage({
      model,
      maxTokens: 8192,
      system: COMPACT_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: compactionPrompt }],
    })

    const summary = response.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('\n')

    return {
      compactedMessages: buildCompactedMessages(summary),
      summary,
      state: {
        compacted: true,
        turnCounter: state.turnCounter,
        consecutiveFailures: 0,
        lastInputTokens: 0,
        lastOutputTokens: 0,
      },
    }
  } catch (err: any) {
    return {
      compactedMessages: messages,
      summary: '',
      state: {
        ...state,
        consecutiveFailures: state.consecutiveFailures + 1,
      },
    }
  }
}

/**
 * Compact a conversation while protecting the most recent queries.
 *
 * Splits the conversation into a "head" (summarized) and a "tail" (kept
 * verbatim). The last message and the most recent PRUNE_PROTECTED_QUERIES user
 * queries are protected; everything before that is summarized via
 * compactConversationStream. Reassembles [summary, ...tail, lastMessage].
 *
 * Used by both auto-compaction and manual `compact()` triggers so that both
 * paths share identical behavior.
 */
export async function* compactConversationWithProtectedTail(
  provider: LLMProvider,
  model: string,
  messages: NormalizedMessageParam[],
  state: AutoCompactState,
  protectedQueries: number = PRUNE_PROTECTED_QUERIES,
  toolProtectedQueries: number = TOOL_PROTECTED_QUERIES,
): AsyncGenerator<SDKCompactMessage, {
  messages: NormalizedMessageParam[]
  state: AutoCompactState
  summary: string
}> {
  // Nothing meaningful to compact.
  if (messages.length < 2) {
    return { messages: [...messages], state, summary: '' }
  }

  const lastMsg = messages[messages.length - 1]
  const historyMsgs = messages.slice(0, -1)

  const userMsgIndices: number[] = []
  for (let i = 0; i < historyMsgs.length; i++) {
    if (isUserQuery(historyMsgs[i])) {
      userMsgIndices.push(i)
    }
  }
  const protectedStart = Math.max(0, userMsgIndices.length - protectedQueries)
  const cutoffIndex = protectedStart < userMsgIndices.length
    ? userMsgIndices[protectedStart]
    : historyMsgs.length

  const headMsgs = historyMsgs.slice(0, cutoffIndex)
  const tailMsgs = historyMsgs.slice(cutoffIndex)

  // `yield*` delegation (review #47 round 2): cancellation from the public
  // stream propagates through to compactConversationStream and onward to the
  // provider's createMessageStream generator (its finally blocks run).
  const result: CompactResult = yield* compactConversationStream(
    provider,
    model,
    headMsgs as any[],
    state,
  )

  // Failure / empty summary → return the caller's array UNCHANGED (identity,
  // never re-assembled, never pruned) — compaction failure contract.
  if (result.summary.length === 0) {
    return { messages, state: result.state, summary: '' }
  }

  // Success → prune ONLY the recent window [...tail, lastMsg] (the leading
  // summary pair is excluded so it cannot consume a protected slot; lastMsg IS
  // included — a pending user query legitimately occupies a slot, spec v4 §4).
  const prunedRecent = pruneForCompaction(
    [...tailMsgs, lastMsg] as any[],
    toolProtectedQueries,
  ) as NormalizedMessageParam[]

  return {
    messages: [
      ...(result.compactedMessages as NormalizedMessageParam[]),
      ...prunedRecent,
    ],
    state: result.state,
    summary: result.summary,
  }
}

/**
 * Strip images from messages for compaction safety.
 */
function stripImagesFromMessages(
  messages: any[],
): any[] {
  return messages.map((msg: any) => {
    if (typeof msg.content === 'string') return msg

    const filtered = (msg.content as any[]).filter((block: any) => {
      return block.type !== 'image'
    })

    return { ...msg, content: filtered.length > 0 ? filtered : '[content removed for compaction]' }
  })
}

/**
 * Truncate long text keeping both head and tail (middle elided).
 */
function truncateHeadTail(text: string, max: number): string {
  if (text.length <= max) return text
  const half = Math.floor(max / 2)
  return text.slice(0, half) + '\n...(truncated)...\n' + text.slice(-half)
}

/**
 * Build compaction prompt from messages.
 */
function buildCompactionPrompt(messages: any[]): string {
  const parts: string[] = ['Please summarize this conversation:\n']

  for (const msg of messages) {
    const role = msg.role === 'user' ? 'User' : 'Assistant'

    if (typeof msg.content === 'string') {
      parts.push(`${role}: ${truncateHeadTail(msg.content, 5000)}`)
    } else if (Array.isArray(msg.content)) {
      const texts: string[] = []
      for (const block of msg.content as any[]) {
        if (block.type === 'text') {
          texts.push(truncateHeadTail(block.text, 5000))
        } else if (block.type === 'tool_use') {
          const input = truncateHeadTail(JSON.stringify(block.input ?? {}), 1000)
          texts.push(`[Tool: ${block.name} ${input}]`)
        } else if (block.type === 'tool_result') {
          const content = typeof block.content === 'string'
            ? truncateHeadTail(block.content, 5000)
            : '[tool result]'
          texts.push(`[Tool Result: ${content}]`)
        }
      }
      if (texts.length > 0) {
        parts.push(`${role}: ${texts.join('\n')}`)
      }
    }
  }

  return parts.join('\n\n')
}

/**
 * In-place: clears oversized tool_result payloads OUTSIDE the protected window
 * (the last `protectedQueries` real queries, by RANGE via
 * computeProtectedBoundary — P0 fix: the previous index-set check could never
 * match tool_result wrapper messages, so nothing was ever protected).
 * Public contract unchanged (void + mutates input). Preserves tool_use blocks,
 * pairing, and Skill results. Default = PRUNE_PROTECTED_QUERIES.
 */
export function pruneMessages(
  messages: any[],
  protectedQueries: number = PRUNE_PROTECTED_QUERIES,
): void {
  const boundary = computeProtectedBoundary(messages, protectedQueries)
  const toolNameMap = buildToolNameMap(messages)
  for (let i = 0; i < messages.length; i++) {
    if (i >= boundary) continue // protected range [boundary, length): skip wholesale
    const msg = messages[i]
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue
    for (const block of msg.content) {
      if (
        block.type === 'tool_result' &&
        typeof block.content === 'string' &&
        block.content.length > PRUNE_THRESHOLD_CHARS
      ) {
        const toolName = toolNameMap.get(block.tool_use_id)
        if (toolName && PROTECTED_TOOL_NAMES.has(toolName)) continue
        block.content = '[Old tool result content cleared]'
      }
    }
  }
}

/**
 * Immutable wrapper used ONLY by the compaction path: clones the window one
 * level deep (message spread + per-block spread — pruneMessages writes only
 * block.content, so one level suffices), then DELEGATES to the public
 * in-place pruneMessages on the clone. The clearing algorithm exists only in
 * pruneMessages (spec v4.1 §3: no duplicated guardrails). Never mutates the
 * caller's objects — the failure contract requires byte-for-byte identical
 * inputs, and the success path shares tail/lastMsg references with the caller.
 * Module-internal (not re-exported at root). Clone depth is pinned by the
 * "caller objects untouched" test: a too-shallow clone would mutate caller
 * blocks and turn it red.
 */
function pruneForCompaction(messages: any[], protectedQueries: number): any[] {
  const cloned = messages.map((msg: any) =>
    Array.isArray(msg?.content)
      ? { ...msg, content: msg.content.map((block: any) => ({ ...block })) }
      : msg,
  )
  pruneMessages(cloned, protectedQueries)
  return cloned
}

export function microCompactMessages(
  messages: any[],
  maxToolResultChars: number = 50000,
): any[] {
  const toolNameMap = buildToolNameMap(messages)

  return messages.map((msg: any) => {
    if (typeof msg.content === 'string') return msg
    if (!Array.isArray(msg.content)) return msg

    const content = (msg.content as any[]).map((block: any) => {
      if (block.type === 'tool_result' && typeof block.content === 'string') {
        if (block.content.length > maxToolResultChars) {
          const toolName = toolNameMap.get(block.tool_use_id)
          if (toolName && PROTECTED_TOOL_NAMES.has(toolName)) return block

          return {
            ...block,
            content:
              block.content.slice(0, maxToolResultChars / 2) +
              '\n...(truncated)...\n' +
              block.content.slice(-maxToolResultChars / 2),
          }
        }
      }
      return block
    })

    return { ...msg, content }
  })
}

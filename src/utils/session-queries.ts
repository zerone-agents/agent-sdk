import type { NormalizedMessageParam } from '../providers/types.js'

/**
 * Check if a user message is a "real" user query (not a pure tool_result
 * wrapper).
 *
 * A user message qualifies if it has string content, or array content
 * containing at least one non-tool_result block. MIXED-CONTENT rule
 * (spec v4.2 §1.1): a `[text, tool_result]` user message IS a query start;
 * only PURE tool_result wrappers (content exclusively tool_result blocks)
 * are excluded. Semantics pinned by session-queries.test.ts.
 */
export function isUserQuery(msg: NormalizedMessageParam): boolean {
  if (msg.role !== 'user') return false
  if (typeof msg.content === 'string') return true

  // Array content: fresh if it has at least one non-tool_result block
  // (content narrowed to the block-array union here; every member has .type)
  return msg.content.some((block) => block.type !== 'tool_result')
}

/**
 * Truncate messages to the last N user queries.
 *
 * A "query" starts at a fresh user message (one whose content is not
 * exclusively tool_result blocks) and includes all subsequent messages
 * until the next fresh user message.
 *
 * If the total number of queries <= maxQueries, returns all messages unchanged.
 * Otherwise, returns only messages from the last maxQueries queries.
 */
export function truncateToLastNQueries(
  messages: NormalizedMessageParam[],
  maxQueries: number,
): NormalizedMessageParam[] {
  // No limit: treat 0 and negative as "no truncation"
  if (maxQueries <= 0) return messages

  // Find all query boundaries (indices of fresh user messages)
  const boundaries: number[] = []
  for (let i = 0; i < messages.length; i++) {
    if (isUserQuery(messages[i])) {
      boundaries.push(i)
    }
  }

  // No truncation needed
  if (boundaries.length <= maxQueries) {
    return messages
  }

  // Cut at the start of the (boundaries.length - maxQueries)-th query
  const cutIndex = boundaries[boundaries.length - maxQueries]
  return messages.slice(cutIndex)
}

/**
 * Count user queries = number of fresh user messages.
 * A fresh user message is one whose content is not exclusively tool_result blocks.
 */
export function countSessionQueries(messages: NormalizedMessageParam[]): number {
  let count = 0
  for (const msg of messages) {
    if (isUserQuery(msg)) count++
  }
  return count
}

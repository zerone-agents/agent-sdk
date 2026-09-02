import type { NormalizedMessageParam } from '../providers/types.js'

/**
 * Check if a user message is a "fresh" user input (not a pure tool_result).
 * A fresh user message has either string content or array content containing
 * at least one non-tool_result block.
 */
function isFreshUserQuery(msg: NormalizedMessageParam): boolean {
  if (msg.role !== 'user') return false
  if (typeof msg.content === 'string') return true

  // Array content: fresh if it has at least one non-tool_result block
  return (msg.content as any[]).some(
    (block: any) => block.type !== 'tool_result',
  )
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
    if (isFreshUserQuery(messages[i])) {
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
    if (isFreshUserQuery(msg)) count++
  }
  return count
}

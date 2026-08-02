import type { NormalizedMessageParam } from '../providers/types.js'

/**
 * Check if a user message is a "fresh" user input (not a pure tool_result).
 * A fresh user message has either string content or array content containing
 * at least one non-tool_result block.
 */
function isFreshUserMessage(msg: NormalizedMessageParam): boolean {
  if (msg.role !== 'user') return false
  if (typeof msg.content === 'string') return true

  // Array content: fresh if it has at least one non-tool_result block
  return (msg.content as any[]).some(
    (block: any) => block.type !== 'tool_result',
  )
}

/**
 * Truncate messages to the last N conversation rounds.
 *
 * A "round" starts at a fresh user message (one whose content is not
 * exclusively tool_result blocks) and includes all subsequent messages
 * until the next fresh user message.
 *
 * If the total number of rounds <= maxTurns, returns all messages unchanged.
 * Otherwise, returns only messages from the last maxTurns rounds.
 */
export function truncateToLastNTurns(
  messages: NormalizedMessageParam[],
  maxTurns: number,
): NormalizedMessageParam[] {
  // No limit: treat 0 and negative as "no truncation"
  if (maxTurns <= 0) return messages

  // Find all turn boundaries (indices of fresh user messages)
  const boundaries: number[] = []
  for (let i = 0; i < messages.length; i++) {
    if (isFreshUserMessage(messages[i])) {
      boundaries.push(i)
    }
  }

  // No truncation needed
  if (boundaries.length <= maxTurns) {
    return messages
  }

  // Cut at the start of the (boundaries.length - maxTurns)-th turn
  const cutIndex = boundaries[boundaries.length - maxTurns]
  return messages.slice(cutIndex)
}

/**
 * Truncate a description for catalog display. If the text exceeds maxLen,
 * append `...(more)` so the model knows content was cut off.
 *
 * Used by:
 * - prompt-builder.ts: <available_deferred_tools> catalog fallback path
 * - tool-search.ts: tool result fallback path
 * - mcp/client.ts: auto-generated shortDescription for external MCP tools
 */
export function truncateForCatalog(text: string, maxLen = 200): string {
  if (!text) return ''
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen) + '...(more)'
}

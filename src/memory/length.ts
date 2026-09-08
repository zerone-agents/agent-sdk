/**
 * Weighted character count matching the Zerone App memory capacity model
 * (static review P2-5): ASCII code points count 1, every other Unicode code
 * point counts 2. Iterated per CODE POINT ([...text] semantics) so surrogate
 * pairs (emoji, rare CJK) count as ONE code point at weight 2.
 */
export function countMemoryChars(text: string): number {
  let total = 0
  for (const ch of text) {
    total += (ch.codePointAt(0) ?? 0) <= 0x7f ? 1 : 2
  }
  return total
}
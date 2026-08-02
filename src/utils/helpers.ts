/**
 * Small general-purpose helpers.
 *
 * Extracted from engine.ts so the tool-executor (and future modules)
 * don't carry unrelated formatting/timing code inline.
 */

/**
 * Create a high-resolution timer.
 * Returns `{ elapsed() }` which gives milliseconds since creation.
 */
export function createTimer(): { elapsed(): number } {
  const start = performance.now()
  return {
    elapsed(): number {
      return performance.now() - start
    },
  }
}

/**
 * Format a millisecond duration into a human-readable string.
 *
 * - `< 1000ms` → `"123ms"`
 * - `>= 1s`    → `"1.23s"`
 */
export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

/**
 * Create a truncated preview of tool input for logging.
 *
 * JSON-stringifies the input and truncates to `maxLength` characters.
 * Returns `'undefined'` for undefined input.
 */
export function formatInputPreview(input: unknown, maxLength = 200): string {
  if (input === undefined) return 'undefined'
  const str = typeof input === 'string' ? input : JSON.stringify(input)
  if (str.length <= maxLength) return str
  return str.slice(0, maxLength) + '...'
}

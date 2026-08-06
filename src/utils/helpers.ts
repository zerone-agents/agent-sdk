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

/**
 * Keys whose values may carry credentials or other sensitive data.
 * Matching is case-insensitive and covers common spellings
 * (api_key / apiKey / api-key, access_token, etc.).
 */
const SENSITIVE_KEY =
  /^(command|env|headers|password|passwd|secret|token|authorization|auth|cookie|credential|credentials|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|private[-_]?key|session[-_]?id|.*[-_]?(secret|token|password|credential)s?)$/i

export const REDACTED = '[REDACTED]'

/**
 * Deep-copy a value with sensitive fields replaced by `[REDACTED]`.
 *
 * Used before logging tool input: redaction is field-aware (applied before
 * truncation) so secrets never leak into log output, even partially.
 * Primitives pass through unchanged; the original value is never mutated.
 */
export function redactSensitiveFields(input: unknown): unknown {
  if (input === null || typeof input !== 'object') return input
  if (Array.isArray(input)) return input.map(redactSensitiveFields)
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactSensitiveFields(value)
  }
  return out
}

/**
 * issue #144: bounded recovery + classification of raw tool-call argument
 * strings.
 *
 * The stream accumulator (and the non-streaming OpenAI fallback) deliver tool
 * input as a raw string when JSON.parse fails — or when parse succeeds but
 * yields a string (double-encoded JSON). This helper normalizes such strings:
 *
 * - parse once; a plain object is accepted as-is
 * - if the first parse yields a STRING, allow exactly ONE more bounded parse
 *   (recovers valid double-encoded objects; never recursively decodes)
 * - anything else is classified so the caller can return a format-specific
 *   error instead of a misleading missing-required-fields error
 */

export type ToolInputErrorKind = 'invalid-json' | 'malformed-inner' | 'not-an-object'

export interface ToolInputFormatError {
  kind: ToolInputErrorKind
  /** Original raw argument string (kept for diagnostics; bound any excerpt before showing it to the LLM). */
  raw: string
  /** Parse offset when the JSON.parse error message carries one. */
  offset?: number
  /** Human-readable description of the decoded value for not-an-object errors ('an array' | 'null' | ...). */
  received?: string
}

export type ToolInputNormalization =
  | { ok: true; value: Record<string, any> }
  | ({ ok: false } & Omit<ToolInputFormatError, 'raw'>)

function isPlainObject(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 'an array' | 'null' | 'a string' | 'a number' | 'a boolean' */
export function describeJsonValue(v: unknown): string {
  if (Array.isArray(v)) return 'an array'
  if (v === null) return 'null'
  const t = typeof v
  if (t === 'string') return 'a string'
  if (t === 'number') return 'a number'
  if (t === 'boolean') return 'a boolean'
  return t
}

/** Extract "... at position N" from a JSON.parse error message, when present. */
function parseOffset(err: unknown): number | undefined {
  const m = /position (\d+)/.exec((err as Error)?.message ?? '')
  return m ? Number(m[1]) : undefined
}

export function normalizeToolInput(raw: string): ToolInputNormalization {
  let first: unknown
  try {
    first = JSON.parse(raw)
  } catch (err) {
    return { ok: false, kind: 'invalid-json', offset: parseOffset(err) }
  }
  if (isPlainObject(first)) return { ok: true, value: first }
  if (typeof first !== 'string') {
    return { ok: false, kind: 'not-an-object', received: describeJsonValue(first) }
  }
  // Double-encoded: the first parse produced a JSON string — allow exactly one
  // more parse. A string result here is NOT parsed again (bounded, #144).
  let second: unknown
  try {
    second = JSON.parse(first)
  } catch (err) {
    return { ok: false, kind: 'malformed-inner', offset: parseOffset(err) }
  }
  if (isPlainObject(second)) return { ok: true, value: second }
  return { ok: false, kind: 'not-an-object', received: describeJsonValue(second) }
}

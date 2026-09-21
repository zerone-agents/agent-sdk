import { MemoryValidationError } from './errors.js'
import type { MemoryRecord } from './types.js'

export const MEMORY_SEARCH_DEFAULT_LIMIT = 10
export const MEMORY_SEARCH_MAX_LIMIT = 50

export type MemoryMatchKind = 'complete' | 'terms'
export interface MemorySearchMatch {
  record: MemoryRecord
  kind: MemoryMatchKind
}

/** Trim + Unicode NFKC + case-fold. Applied to BOTH content and query. */
export function normalizeMemoryText(input: string): string {
  return input.normalize('NFKC').toLowerCase().trim()
}

/** Split a normalized query on Unicode whitespace and punctuation. */
function queryTerms(normalizedQuery: string): string[] {
  return normalizedQuery.split(/[\p{White_Space}\p{P}]+/u).filter((t) => t.length > 0)
}

/**
 * A record matches when the normalized content contains the complete
 * normalized query, or every non-empty query term appears as a substring.
 *
 * The query may carry '|'-separated OR alternatives (e.g. `foo|bar baz`):
 * a record matches if ANY alternative matches — each alternative keeps full
 * single-query semantics (complete substring, then all-terms within it) —
 * and a complete match on any alternative wins the match kind. Degenerate
 * pipes (`a|`, `||`) degrade to the remaining non-empty alternatives.
 */
export function matchMemoryRecord(normalizedContent: string, normalizedQuery: string): MemoryMatchKind | null {
  if (normalizedQuery.length === 0) return null
  const alternatives = normalizedQuery.split('|').map((a) => a.trim()).filter((a) => a.length > 0)
  let best: MemoryMatchKind | null = null
  for (const alternative of alternatives) {
    if (normalizedContent.includes(alternative)) return 'complete'
    const terms = queryTerms(alternative)
    if (terms.length >= 1 && terms.every((t) => normalizedContent.includes(t))) best = 'terms'
  }
  return best
}

/**
 * Deterministic result order: match kind, importance desc, updatedAt desc, id asc.
 * Precondition: `updatedAt` is an ISO-8601 UTC timestamp string — byte-wise
 * (lexicographic) comparison then equals chronological order.
 */
export function compareMemorySearchResults(a: MemorySearchMatch, b: MemorySearchMatch): number {
  if (a.kind !== b.kind) return a.kind === 'complete' ? -1 : 1
  if (a.record.importance !== b.record.importance) return b.record.importance - a.record.importance
  if (a.record.updatedAt !== b.record.updatedAt) return a.record.updatedAt < b.record.updatedAt ? 1 : -1
  return a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0
}

/** Positive integer; > MAX caps to MAX; non-positive/non-integer rejects. */
export function resolveMemorySearchLimit(limit?: number): number {
  if (limit === undefined) return MEMORY_SEARCH_DEFAULT_LIMIT
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new MemoryValidationError([
      { code: 'search.limit', severity: 'error', message: `Search limit must be a positive integer, got ${limit}.` },
    ])
  }
  return Math.min(limit, MEMORY_SEARCH_MAX_LIMIT)
}
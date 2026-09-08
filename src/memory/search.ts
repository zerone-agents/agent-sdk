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
 */
export function matchMemoryRecord(normalizedContent: string, normalizedQuery: string): MemoryMatchKind | null {
  if (normalizedQuery.length === 0) return null
  if (normalizedContent.includes(normalizedQuery)) return 'complete'
  const terms = queryTerms(normalizedQuery)
  if (terms.length >= 1 && terms.every((t) => normalizedContent.includes(t))) return 'terms'
  return null
}

/** Deterministic result order: match kind, importance desc, updatedAt desc, id asc. */
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
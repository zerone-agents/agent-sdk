import { describe, expect, it } from 'vitest'
import {
  MEMORY_SEARCH_DEFAULT_LIMIT,
  MEMORY_SEARCH_MAX_LIMIT,
  compareMemorySearchResults,
  matchMemoryRecord,
  normalizeMemoryText,
  resolveMemorySearchLimit,
} from './search.js'
import type { MemoryRecord } from './types.js'

function rec(partial: Partial<MemoryRecord> & { id: string }): MemoryRecord {
  return {
    scope: 'global', workspaceId: null, content: '', importance: 50,
    status: 'active', revision: 1, createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z', deletedAt: null, ...partial,
  }
}

describe('normalizeMemoryText', () => {
  it('trims, NFKC-normalizes, and case-folds', () => {
    expect(normalizeMemoryText('  Héllo　ＷORLD ')).toBe('héllo world')
  })
})

describe('matchMemoryRecord', () => {
  it('matches a complete-query substring (case/width-insensitive)', () => {
    expect(matchMemoryRecord(normalizeMemoryText('部署在阿里云 ECS'), normalizeMemoryText('阿里云 ecs'))).toBe('complete')
  })

  it('matches when every whitespace/punctuation-split term appears', () => {
    expect(matchMemoryRecord(normalizeMemoryText('the quick brown fox'), normalizeMemoryText('fox, quick'))).toBe('terms')
  })

  it('returns null when any term is missing', () => {
    expect(matchMemoryRecord(normalizeMemoryText('the quick brown fox'), normalizeMemoryText('fox, hedgehog'))).toBeNull()
  })

  it('a SINGLE term from a punctuated query matches as terms (round-2 P2)', () => {
    expect(matchMemoryRecord(normalizeMemoryText('hello world'), normalizeMemoryText('hello!'))).toBe('terms')
  })

  it('a pure-punctuation query (empty term set) matches nothing', () => {
    expect(matchMemoryRecord(normalizeMemoryText('hello world'), '!!!')).toBeNull()
  })

  it('CJK fragment without spaces matches as a complete substring', () => {
    expect(matchMemoryRecord(normalizeMemoryText('路径安全平台陷阱'), normalizeMemoryText('平台陷阱'))).toBe('complete')
  })

  it('empty query never matches', () => {
    expect(matchMemoryRecord(normalizeMemoryText('anything'), '')).toBeNull()
  })
})

describe('compareMemorySearchResults', () => {
  it('orders: complete before terms, importance desc, updatedAt desc, id asc', () => {
    const completeLow = { record: rec({ id: 'a', importance: 25 }), kind: 'complete' as const }
    const termsHigh = { record: rec({ id: 'b', importance: 100 }), kind: 'terms' as const }
    expect(compareMemorySearchResults(completeLow, termsHigh)).toBeLessThan(0)

    const imp75 = { record: rec({ id: 'c', importance: 75 }), kind: 'terms' as const }
    const imp50Newer = { record: rec({ id: 'd', importance: 50, updatedAt: '2026-06-01T00:00:00.000Z' }), kind: 'terms' as const }
    expect(compareMemorySearchResults(imp75, imp50Newer)).toBeLessThan(0)

    const older = { record: rec({ id: 'e', importance: 50, updatedAt: '2026-01-01T00:00:00.000Z' }), kind: 'terms' as const }
    expect(compareMemorySearchResults(imp50Newer, older)).toBeLessThan(0)

    const sameTime1 = { record: rec({ id: 'a1', importance: 50 }), kind: 'terms' as const }
    const sameTime2 = { record: rec({ id: 'a2', importance: 50 }), kind: 'terms' as const }
    expect(compareMemorySearchResults(sameTime1, sameTime2)).toBeLessThan(0)
  })
})

describe('resolveMemorySearchLimit', () => {
  it('defaults to 10, caps at 50, rejects non-positive and non-integer', () => {
    expect(resolveMemorySearchLimit(undefined)).toBe(MEMORY_SEARCH_DEFAULT_LIMIT)
    expect(resolveMemorySearchLimit(10)).toBe(10)
    expect(resolveMemorySearchLimit(500)).toBe(MEMORY_SEARCH_MAX_LIMIT)
    expect(() => resolveMemorySearchLimit(0)).toThrowError(/limit/i)
    expect(() => resolveMemorySearchLimit(-3)).toThrowError(/limit/i)
    expect(() => resolveMemorySearchLimit(2.5)).toThrowError(/limit/i)
  })
})
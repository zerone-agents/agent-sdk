import { describe, it, expect } from 'vitest'
import { normalizeMessagesForAPI, truncateText } from './messages.js'

describe('normalizeMessagesForAPI metadata stripping (issue #54)', () => {
  it('omits id/timestamp/_snapshot/rawUsage from every output message', () => {
    const messages = [
      {
        role: 'user',
        content: 'hi',
        id: 'u1',
        timestamp: '2026-08-26T00:00:00.000Z',
        _snapshot: { beforeHash: 'abc' },
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'yo' }],
        id: 'a1',
        timestamp: '2026-08-26T00:00:01.000Z',
        rawUsage: { x: 1 },
      },
    ] as any[]

    const normalized = normalizeMessagesForAPI(messages)
    expect(normalized).toHaveLength(2)
    for (const msg of normalized) {
      expect(msg).not.toHaveProperty('id')
      expect(msg).not.toHaveProperty('timestamp')
      expect(msg).not.toHaveProperty('_snapshot')
      expect(msg).not.toHaveProperty('rawUsage')
      expect(Object.keys(msg).sort()).toEqual(['content', 'role'])
    }
  })

  it('strips metadata from same-role merged messages (merge path)', () => {
    const messages = [
      { role: 'user', content: 'first', id: 'u1', timestamp: '2026-08-26T00:00:00.000Z' },
      {
        role: 'user',
        content: [{ type: 'text', text: 'second' }],
        id: 'u2',
        timestamp: '2026-08-26T00:00:01.000Z',
        _snapshot: { beforeHash: 'xyz' },
        rawUsage: { y: 2 },
      },
    ] as any[]

    const normalized = normalizeMessagesForAPI(messages)
    expect(normalized).toHaveLength(1)
    const merged = normalized[0]
    expect(merged.role).toBe('user')
    expect(Array.isArray(merged.content)).toBe(true)
    expect((merged.content as any[]).map((b) => b.text)).toEqual(['first', 'second'])
    expect(Object.keys(merged).sort()).toEqual(['content', 'role'])
  })
})

describe('truncateText surrogate safety (issue #133)', () => {
  // U+1F1EA occupies two UTF-16 code units; naive slice() boundaries can land
  // between them and emit an unpaired surrogate.
  const EMOJI = '\u{1F1EA}'

  /** ES2024 isWellFormed equivalent (repo target is ES2022). */
  function isWellFormed(s: string): boolean {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i)
      if (c >= 0xd800 && c <= 0xdbff) {
        const n = i + 1 < s.length ? s.charCodeAt(i + 1) : 0
        if (n < 0xdc00 || n > 0xdfff) return false
        i++
      } else if (c >= 0xdc00 && c <= 0xdfff) {
        return false
      }
    }
    return true
  }

  it('head cut never ends mid-pair', () => {
    const out = truncateText('a'.repeat(2499) + EMOJI + 'b'.repeat(2500), 5000)
    expect(out).toContain('...(truncated)...')
    expect(isWellFormed(out)).toBe(true)
  })

  it('tail cut never starts mid-pair', () => {
    const out = truncateText('a'.repeat(3000) + EMOJI + 'b'.repeat(2499), 5000)
    expect(out).toContain('...(truncated)...')
    expect(isWellFormed(out)).toBe(true)
  })
})

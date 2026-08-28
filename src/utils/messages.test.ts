import { describe, it, expect } from 'vitest'
import { normalizeMessagesForAPI } from './messages.js'

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

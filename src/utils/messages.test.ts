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
})

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  saveSession,
  loadSession,
  forkSession,
  deleteSession,
} from './session.js'
import type { NormalizedMessageParam } from './providers/types.js'

describe('forkSession', () => {
  const sourceId = `fork-test-source-${crypto.randomUUID()}`
  const forkDefaultId = `fork-test-default-${crypto.randomUUID()}`
  const forkPreserveId = `fork-test-preserve-${crypto.randomUUID()}`

  beforeAll(async () => {
    const messages: NormalizedMessageParam[] = [
      { role: 'user', content: 'hello', id: 'u1', _snapshot: { beforeHash: 'abc' } },
      { role: 'assistant', content: 'hi', id: 'a1' },
      { role: 'user', content: 'world', id: 'u2', _snapshot: { beforeHash: 'def' } },
      { role: 'assistant', content: '!', id: 'a2' },
    ]
    await saveSession(sourceId, messages, { cwd: process.cwd(), model: 'test' })
  })

  afterAll(async () => {
    await deleteSession(sourceId)
    await deleteSession(forkDefaultId)
    await deleteSession(forkPreserveId)
  })

  it('regenerates message IDs by default and strips _snapshot', async () => {
    const id = await forkSession({ sessionId: sourceId, messageId: 'u2' }, forkDefaultId)
    expect(id).toBe(forkDefaultId)

    const data = await loadSession(forkDefaultId)
    expect(data).not.toBeNull()
    expect(data!.messages).toHaveLength(3)

    // IDs are regenerated: no overlap with source
    const sourceIds = ['u1', 'a1', 'u2']
    for (const msg of data!.messages) {
      expect(sourceIds).not.toContain(msg.id)
      expect(msg).not.toHaveProperty('_snapshot')
    }
  })

  it('preserves message IDs when preserveIds=true and still strips _snapshot', async () => {
    const id = await forkSession(
      { sessionId: sourceId, messageId: 'u2' },
      forkPreserveId,
      { preserveIds: true },
    )
    expect(id).toBe(forkPreserveId)

    const data = await loadSession(forkPreserveId)
    expect(data).not.toBeNull()
    expect(data!.messages).toHaveLength(3)

    const ids = data!.messages.map((m) => m.id)
    expect(ids).toEqual(['u1', 'a1', 'u2'])

    for (const msg of data!.messages) {
      expect(msg).not.toHaveProperty('_snapshot')
    }
  })
})

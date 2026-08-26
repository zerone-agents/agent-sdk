import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  saveSession,
  loadSession,
  forkSession,
  deleteSession,
} from './session.js'
import type { NormalizedMessageParam } from './providers/types.js'
import { join } from 'path'
import { readdir } from 'fs/promises'

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

describe('saveSession atomic replacement (review #47 P1)', () => {
  const sid = `atomic-test-${crypto.randomUUID()}`

  afterAll(async () => {
    await deleteSession(sid)
  })

  it('leaves no temporary files after a successful save', async () => {
    await saveSession(sid, [{ role: 'user', content: 'hi' }], {
      cwd: process.cwd(),
      model: 'test',
    })

    const dir = join(
      process.env.HOME || process.env.USERPROFILE || '/tmp',
      '.agents', 'sessions', sid,
    )
    const files = await readdir(dir)
    expect(files).toEqual(['transcript.json'])

    // Repeated saves also stay clean (tmp names are unique per write)
    await saveSession(sid, [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok' }], {
      cwd: process.cwd(),
      model: 'test',
    })
    const filesAfter = await readdir(dir)
    expect(filesAfter).toEqual(['transcript.json'])

    // And the final content is the complete second save
    const data = await loadSession(sid)
    expect(data!.messages).toHaveLength(2)
  })
})

describe('session timestamps (issue #54)', () => {
  const sid = `ts-test-${crypto.randomUUID()}`

  afterAll(async () => {
    await deleteSession(sid)
  })

  it('round-trips timestamps unchanged and never backfills missing ones', async () => {
    const messages: NormalizedMessageParam[] = [
      { role: 'user', content: 'old', id: 'u1' }, // old transcript: no timestamp
      { role: 'assistant', content: 'new', id: 'a1', timestamp: '2026-08-26T00:00:00.000Z' },
    ]
    await saveSession(sid, messages, { cwd: process.cwd(), model: 'test' })

    const loaded = await loadSession(sid)
    expect(loaded!.messages[1].timestamp).toBe('2026-08-26T00:00:00.000Z')
    expect(loaded!.messages[0].timestamp).toBeUndefined()
    expect('timestamp' in loaded!.messages[0]).toBe(false) // key absent, not just undefined

    // Repeated save of loaded data never rewrites or invents timestamps.
    await saveSession(sid, loaded!.messages, loaded!.metadata)
    const reloaded = await loadSession(sid)
    expect(reloaded!.messages[1].timestamp).toBe('2026-08-26T00:00:00.000Z')
    expect('timestamp' in reloaded!.messages[0]).toBe(false)
  })
})

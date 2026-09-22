import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FileSessionStorage,
  SessionDataInvalidError,
  defaultSessionStorage,
  loadSessionFrom,
  saveSessionTo,
} from './session-storage.js'
import type { NormalizedMessageParam } from './providers/types.js'

let tmpRoot = ''
afterEach(() => {
  if (tmpRoot) { rmSync(tmpRoot, { recursive: true, force: true }); tmpRoot = '' }
})
function freshDir(): string {
  tmpRoot = mkdtempSync(join(tmpdir(), 'sess-storage-'))
  return tmpRoot
}
const msg = (text: string): NormalizedMessageParam =>
  ({ role: 'user', content: text } as NormalizedMessageParam)

describe('FileSessionStorage + wrappers (issue #4)', () => {
  it('save→load roundtrip via saveSessionTo/loadSessionFrom', async () => {
    const storage = new FileSessionStorage({ baseDir: freshDir() })
    await saveSessionTo(storage, 's1', [msg('hi')], { cwd: '/w', model: 'm' })
    const data = await loadSessionFrom(storage, 's1')
    expect(data).not.toBeNull()
    expect(data!.messages).toHaveLength(1)
    expect(data!.messages[0].id).toBeTruthy()          // ensureMessageIds
    expect(data!.metadata.id).toBe('s1')
    expect(data!.metadata.messageCount).toBe(1)
    expect(data!.metadata.model).toBe('m')
    expect(data!.metadata.createdAt).toBeTruthy()
    expect(data!.metadata.updatedAt).toBeTruthy()
  })

  it('load: nonexistent → null', async () => {
    const storage = new FileSessionStorage({ baseDir: freshDir() })
    expect(await loadSessionFrom(storage, 'nope')).toBeNull()
  })

  it('createdAt preserved when partial provides it; minted once when absent', async () => {
    const storage = new FileSessionStorage({ baseDir: freshDir() })
    await saveSessionTo(storage, 's1', [msg('hi')], { cwd: '/w', model: 'm', createdAt: '2020-01-01T00:00:00.000Z' })
    const data = await loadSessionFrom(storage, 's1')
    expect(data!.metadata.createdAt).toBe('2020-01-01T00:00:00.000Z')
    await saveSessionTo(storage, 's1', [msg('hi2')], { cwd: '/w', model: 'm', createdAt: '2020-01-01T00:00:00.000Z' })
    expect((await loadSessionFrom(storage, 's1'))!.metadata.createdAt).toBe('2020-01-01T00:00:00.000Z')
  })

  it('atomic write: only transcript.json remains in the session dir', async () => {
    const storage = new FileSessionStorage({ baseDir: freshDir() })
    await saveSessionTo(storage, 's1', [msg('hi')], { cwd: '/w', model: 'm' })
    expect(readdirSync(join(tmpRoot, 's1'))).toEqual(['transcript.json'])
  })

  it('legacy format: written JSON has no revision/tag keys', async () => {
    const storage = new FileSessionStorage({ baseDir: freshDir() })
    await saveSessionTo(storage, 's1', [msg('hi')], { cwd: '/w', model: 'm' })
    const raw = JSON.parse(readFileSync(join(tmpRoot, 's1', 'transcript.json'), 'utf-8'))
    expect(Object.keys(raw.metadata)).not.toContain('revision')
    expect(Object.keys(raw.metadata)).not.toContain('tag')
  })

  it('lazy $HOME: default instance follows env changes per call', async () => {
    const home = freshDir()
    const prev = process.env.HOME
    process.env.HOME = home
    try {
      expect(defaultSessionStorage).toBeInstanceOf(FileSessionStorage)
      await saveSessionTo(defaultSessionStorage, 'lazy-1', [msg('hi')], { cwd: '/w', model: 'm' })
      expect(readdirSync(join(home, '.agents', 'sessions'))).toContain('lazy-1')
    } finally {
      process.env.HOME = prev
    }
  })

  it('delete + list', async () => {
    const storage = new FileSessionStorage({ baseDir: freshDir() })
    await saveSessionTo(storage, 'a', [msg('a')], { cwd: '/w', model: 'm' })
    await saveSessionTo(storage, 'b', [msg('b')], { cwd: '/w', model: 'm' })
    expect(await storage.delete!('a')).toBe(true)
    expect(await loadSessionFrom(storage, 'a')).toBeNull()
    const metas = await storage.list!()
    expect(metas.map((m) => m.id)).toEqual(['b'])
  })

  it('loadSessionFrom shape validation: metadata.id mismatch throws SessionDataInvalidError', async () => {
    const root = freshDir()
    mkdirSync(join(root, 'bad'), { recursive: true })
    writeFileSync(join(root, 'bad', 'transcript.json'), JSON.stringify({
      metadata: { id: 'other-id', cwd: '/', model: 'm', createdAt: 'x', updatedAt: 'x', messageCount: 0 },
      messages: [],
    }))
    await expect(loadSessionFrom(new FileSessionStorage({ baseDir: root }), 'bad'))
      .rejects.toThrow(SessionDataInvalidError)
  })
})

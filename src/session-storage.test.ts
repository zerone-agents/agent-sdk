import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FileSessionStorage,
  SessionConflictError,
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

describe('revision tri-state CAS (issue #4)', () => {
  it('omitted opts: upsert, no revision key written (byte-compat)', async () => {
    const storage = new FileSessionStorage({ baseDir: freshDir() })
    await saveSessionTo(storage, 's1', [msg('v1')], { cwd: '/w', model: 'm' })
    await saveSessionTo(storage, 's1', [msg('v2')], { cwd: '/w', model: 'm' })  // overwrite OK
    const raw = JSON.parse(readFileSync(join(tmpRoot, 's1', 'transcript.json'), 'utf-8'))
    expect(Object.keys(raw.metadata)).not.toContain('revision')
  })

  it('expectedRevision null: create-only → revision 1; existing → SessionConflictError', async () => {
    const storage = new FileSessionStorage({ baseDir: freshDir() })
    await saveSessionTo(storage, 's1', [msg('v1')], { cwd: '/w', model: 'm' }, { expectedRevision: null })
    const data = await loadSessionFrom(storage, 's1')
    expect(data!.metadata.revision).toBe(1)
    await expect(saveSessionTo(storage, 's1', [msg('x')], { cwd: '/w', model: 'm' }, { expectedRevision: null }))
      .rejects.toThrow(SessionConflictError)
  })

  it('expectedRevision number: match writes expected+1; mismatch throws with actualRevision', async () => {
    const storage = new FileSessionStorage({ baseDir: freshDir() })
    await saveSessionTo(storage, 's1', [msg('v1')], { cwd: '/w', model: 'm' }, { expectedRevision: null }) // rev 1
    await saveSessionTo(storage, 's1', [msg('v2')], { cwd: '/w', model: 'm' }, { expectedRevision: 1 })    // rev 2
    expect((await loadSessionFrom(storage, 's1'))!.metadata.revision).toBe(2)
    const err = await saveSessionTo(storage, 's1', [msg('x')], { cwd: '/w', model: 'm' }, { expectedRevision: 5 })
      .catch((e) => e)
    expect(err).toBeInstanceOf(SessionConflictError)
    expect(err.actualRevision).toBe(2)
  })

  it('CAS on absent session with numeric expected → conflict', async () => {
    const storage = new FileSessionStorage({ baseDir: freshDir() })
    await expect(saveSessionTo(storage, 'ghost', [msg('x')], { cwd: '/w', model: 'm' }, { expectedRevision: 0 }))
      .rejects.toThrow(SessionConflictError)
  })
})

describe('todos contract (issue #128)', () => {
  const todo = (content: string) => ({ content, status: 'pending' as const, priority: 'high' as const })

  it('loadTodos: missing file → []', async () => {
    const storage = new FileSessionStorage({ baseDir: freshDir() })
    expect(await storage.loadTodos('s1')).toEqual([])
  })

  it('loadTodos: reads legacy format { updatedAt, todos }', async () => {
    const root = freshDir()
    mkdirSync(join(root, 's1'), { recursive: true })
    writeFileSync(join(root, 's1', 'todos.json'), JSON.stringify({ updatedAt: 'x', todos: [todo('a')] }))
    const storage = new FileSessionStorage({ baseDir: root })
    expect(await storage.loadTodos('s1')).toEqual([todo('a')])
  })

  it('loadTodos: corrupt json → SessionDataInvalidError', async () => {
    const root = freshDir()
    mkdirSync(join(root, 's1'), { recursive: true })
    writeFileSync(join(root, 's1', 'todos.json'), '{not json')
    await expect(new FileSessionStorage({ baseDir: root }).loadTodos('s1')).rejects.toThrow(SessionDataInvalidError)
  })

  it('loadTodos: non-array todos → SessionDataInvalidError', async () => {
    const root = freshDir()
    mkdirSync(join(root, 's1'), { recursive: true })
    writeFileSync(join(root, 's1', 'todos.json'), JSON.stringify({ updatedAt: 'x', todos: 'nope' }))
    await expect(new FileSessionStorage({ baseDir: root }).loadTodos('s1')).rejects.toThrow(SessionDataInvalidError)
  })

  it('loadTodos: invalid todo entry → SessionDataInvalidError', async () => {
    const root = freshDir()
    mkdirSync(join(root, 's1'), { recursive: true })
    writeFileSync(join(root, 's1', 'todos.json'), JSON.stringify({ updatedAt: 'x', todos: [{ content: 'a', status: 'bogus', priority: 'high' }] }))
    await expect(new FileSessionStorage({ baseDir: root }).loadTodos('s1')).rejects.toThrow(SessionDataInvalidError)
  })

  it('loadTodos: IO error propagates (baseDir is a file → ENOTDIR), never []', async () => {
    const root = freshDir()
    const blocker = join(root, 'blocker.txt')
    writeFileSync(blocker, 'x')
    await expect(new FileSessionStorage({ baseDir: blocker }).loadTodos('s1')).rejects.toThrow()
  })

  it('todos: invalid sessionId → throws with no filesystem side effects', async () => {
    const root = freshDir()
    const storage = new FileSessionStorage({ baseDir: root })
    await expect(storage.loadTodos('../outside')).rejects.toThrow(/sessionId/)
    await expect(storage.loadTodos('')).rejects.toThrow(/sessionId/)
    await expect(storage.saveTodos('a/b', [])).rejects.toThrow(/sessionId/)
    expect(readdirSync(root)).toEqual([])
  })

  it('saveTodos: round-trip + atomic (only todos.json remains)', async () => {
    const storage = new FileSessionStorage({ baseDir: freshDir() })
    const todos = [{ content: 'a', status: 'in_progress' as const, priority: 'medium' as const }]
    await storage.saveTodos('s1', todos)
    expect(await storage.loadTodos('s1')).toEqual(todos)
    expect(readdirSync(join(tmpRoot, 's1'))).toEqual(['todos.json'])
  })
})

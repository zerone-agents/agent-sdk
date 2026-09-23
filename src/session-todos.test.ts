import { describe, expect, it } from 'vitest'
import { mkdtempSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { FileSessionStorage, saveSessionTo, SessionConflictError } from './session-storage.js'
import { InMemorySessionStorage } from './session-storage-fake.js'
import { createSessionManager } from './session-manager.js'
import { Agent } from './agent.js'
import type { AgentOptions, TodoInfo } from './types.js'
import type { NormalizedMessageParam } from './providers/types.js'

const todo = (content: string): TodoInfo => ({ content, status: 'pending', priority: 'high' })

/** Narrow Agent internals seam (same pattern as agent.session-storage.test.ts). */
interface AgentInternals {
  setupDone: Promise<void>
  history: NormalizedMessageParam[]
  persistCheckpoint(): Promise<void>
}
function internals(agent: Agent): AgentInternals {
  return agent as unknown as AgentInternals
}
function agentBase(overrides: Partial<AgentOptions> = {}): AgentOptions {
  return { model: 'test-model', apiKey: 'fake', persistSession: false, enableFileRevert: false, mcpServers: {}, ...overrides }
}

describe('todo/transcript integration matrix (issue #128)', () => {
  it('#3: todos before first transcript create-only checkpoint → no false conflict', async () => {
    const fake = new InMemorySessionStorage()
    await fake.saveTodos('n1', [todo('a')])
    // first transcript checkpoint: create-only (expectedRevision: null) succeeds
    await saveSessionTo(fake, 'n1', [{ role: 'user', content: 'x' }], { cwd: '/w', model: 'm' }, { expectedRevision: null })
    expect(fake.store.get('n1')!.metadata.revision).toBe(1)
  })

  it('#4: todo update does not advance transcript revision', async () => {
    const fake = new InMemorySessionStorage()
    await saveSessionTo(fake, 'r1', [{ role: 'user', content: 'x' }], { cwd: '/w', model: 'm' }, { expectedRevision: null })  // rev 1
    await fake.saveTodos('r1', [todo('a')])
    expect(fake.store.get('r1')!.metadata.revision).toBe(1)
  })

  it('#4b: transcript CAS conflict leaves todos untouched', async () => {
    const fake = new InMemorySessionStorage()
    await saveSessionTo(fake, 'c1', [{ role: 'user', content: 'x' }], { cwd: '/w', model: 'm' }, { expectedRevision: null })
    await fake.saveTodos('c1', [todo('keep')])
    const cur = fake.store.get('c1')!
    await saveSessionTo(fake, 'c1', cur.messages, cur.metadata, { expectedRevision: 1 })   // external bump → rev 2
    await expect(
      saveSessionTo(fake, 'c1', [{ role: 'user', content: 'y' }], { cwd: '/w', model: 'm' }, { expectedRevision: 1 }),
    ).rejects.toThrow(SessionConflictError)
    expect(await fake.loadTodos('c1')).toEqual([todo('keep')])
  })

  it('#5: file backend delete() removes transcript AND todos; fork does not copy todos', async () => {
    const root = mkdtempSync(join(tmpdir(), 'todos-matrix-'))
    const storage = new FileSessionStorage({ baseDir: root })
    const mgr = createSessionManager({ storage })
    await storage.saveTodos('d1', [todo('x')])
    await storage.saveTodos('f1', [todo('orig')])
    await saveSessionTo(storage, 'f1', [{ id: 'm1', role: 'user', content: 'x' }], { cwd: '/w', model: 'm' }, { expectedRevision: null })
    await saveSessionTo(storage, 'd1', [{ id: 'm1', role: 'user', content: 'x' }], { cwd: '/w', model: 'm' }, { expectedRevision: null })
    expect(await mgr.delete('d1')).toBe(true)
    expect(existsSync(join(root, 'd1'))).toBe(false)             // whole dir gone — todos too

    const forkId = await mgr.fork({ sessionId: 'f1', messageId: 'm1' }, 'fork-todos')
    expect(await storage.loadTodos(forkId)).toEqual([])          // fork does NOT copy todo state
  })

  it('#5b: revert does not touch todos', async () => {
    const fake = new InMemorySessionStorage()
    await saveSessionTo(fake, 'rc', [{ id: 'a1', role: 'user', content: 'x' }], { cwd: '/w', model: 'm' }, { expectedRevision: null })
    await fake.saveTodos('rc', [todo('stable')])
    const mgr = createSessionManager({ storage: fake })
    await mgr.revert('rc', 'a1')
    expect(await fake.loadTodos('rc')).toEqual([todo('stable')])
  })

  it('#7: resume from custom storage keeps todos across checkpoint', async () => {
    const fake = new InMemorySessionStorage()
    await saveSessionTo(fake, 'r2', [{ id: 'm1', role: 'user', content: 'hi' }], { cwd: '/w', model: 'm' }, { expectedRevision: null })
    await fake.saveTodos('r2', [todo('task')])
    const agent = new Agent(agentBase({ persistSession: true, sessionStorage: fake, resume: 'r2' }))
    await internals(agent).setupDone
    internals(agent).history = [{ id: 'm2', role: 'user', content: 'more' }]
    await internals(agent).persistCheckpoint()
    expect(fake.store.get('r2')!.metadata.revision).toBe(2)      // checkpoint advanced transcript
    expect(await fake.loadTodos('r2')).toEqual([todo('task')])   // todos intact
  })
})
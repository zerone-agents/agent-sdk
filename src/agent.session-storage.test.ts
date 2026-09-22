import { describe, expect, it, vi } from 'vitest'
import { Agent } from './agent.js'
import type { AgentOptions } from './types.js'
import { InMemorySessionStorage } from './session-storage-fake.js'
import { SessionConflictError, SessionNotFoundError, saveSessionTo } from './session-storage.js'

/** Mirrors agent.test.ts makeBaseOptions — no MCP, no disk writes. */
function base(overrides: Partial<AgentOptions> = {}): AgentOptions {
  return {
    model: 'test-model',
    apiKey: 'fake',
    persistSession: false,
    enableFileRevert: false,
    mcpServers: {},
    ...overrides,
  }
}

describe('AgentOptions.sessionCloseTimeoutMs validation (issue #4)', () => {
  it.each([NaN, Infinity, -1])('rejects %s with TypeError at construction', (bad) => {
    expect(() => new Agent(base({ sessionCloseTimeoutMs: bad }))).toThrow(TypeError)
  })
  it('accepts 0 and positive finite numbers', () => {
    expect(() => new Agent(base({ sessionCloseTimeoutMs: 0 }))).not.toThrow()
    expect(() => new Agent(base({ sessionCloseTimeoutMs: 500 }))).not.toThrow()
  })
})

describe('close() ordering + bounded checkpoint wait (issue #4)', () => {
  it('sessionCloseTimeoutMs: 0 → no save issued at close', async () => {
    const fake = new InMemorySessionStorage()
    const agent = new Agent(base({ persistSession: true, sessionStorage: fake, sessionCloseTimeoutMs: 0 }))
    await agent.close()
    expect(fake.saveCalls).toHaveLength(0)
  })

  it('never-resolving save does not block close() beyond the timeout', async () => {
    const fake = new InMemorySessionStorage()
    let release!: () => void
    const held = new Promise<void>((r) => { release = r })
    fake.save = async () => { await held }        // hang the save
    const agent = new Agent(base({ persistSession: true, sessionStorage: fake, sessionCloseTimeoutMs: 50 }))
    ;(agent as any).history = [{ id: 'm1', role: 'user', content: 'x' }]
    const t0 = Date.now()
    await agent.close()
    expect(Date.now() - t0).toBeLessThan(2000)
    release()                                     // let the background write settle; no unhandled rejection
  })

  it('history checkpoint goes through the injected storage', async () => {
    const fake = new InMemorySessionStorage()
    const agent = new Agent(base({ persistSession: true, sessionStorage: fake }))
    ;(agent as any).history = [{ id: 'm1', role: 'user', content: 'x' }]
    await agent.close()
    expect(fake.saveCalls.map((c) => c.sessionId)).toHaveLength(1)
    // custom storage without explicit mode → strict (spec §7 inference);
    // new session → first checkpoint is create-only (expectedRevision: null).
    // The explicit best-effort override is covered by the T6 test below.
    expect(fake.saveCalls[0].opts?.expectedRevision).toBeNull()
  })
})

describe('strict resume (issue #4 spec §7)', () => {
  it('missing session: setup fails, no save, no substitute session', async () => {
    const fake = new InMemorySessionStorage()
    const agent = new Agent(base({ persistSession: true, sessionStorage: fake, resume: 'ghost' }))
    await expect(agent.prompt('hi')).rejects.toThrow(SessionNotFoundError)
    expect(fake.saveCalls).toHaveLength(0)       // no save issued
    expect(fake.store.size).toBe(0)              // no substitute session created
  })
})

describe('strict checkpoint CAS (issue #4 spec §7)', () => {
  it('tracks loaded revision; each checkpoint CAS-matches and bumps', async () => {
    const fake = new InMemorySessionStorage()
    await saveSessionTo(fake, 's1', [{ id: 'm0', role: 'user', content: 'seed' } as any],
      { cwd: '/w', model: 'm' }, { expectedRevision: null })          // revision 1 (saveCalls[0])
    const agent = new Agent(base({ persistSession: true, sessionStorage: fake, resume: 's1' }))
    await (agent as any).setupDone
    ;(agent as any).history = [{ id: 'm1', role: 'user', content: 'x' }]
    await (agent as any).persistCheckpoint()
    expect(fake.saveCalls[1].opts?.expectedRevision).toBe(1)           // CAS-matched the loaded revision
    expect(fake.store.get('s1')!.metadata.revision).toBe(2)
    ;(agent as any).history = [{ id: 'm2', role: 'user', content: 'y' }]
    await (agent as any).persistCheckpoint()
    expect(fake.saveCalls[2].opts?.expectedRevision).toBe(2)           // bumped and re-matched
    expect(fake.store.get('s1')!.metadata.revision).toBe(3)
    // createdAt stability: both checkpoints reuse the loaded value
    expect(fake.saveCalls[1].metadata.createdAt).toBe(fake.saveCalls[2].metadata.createdAt)
    expect(fake.saveCalls[1].metadata.createdAt).toBe(fake.store.get('s1')!.metadata.createdAt)
  })

  it('external writer advances revision → next checkpoint throws SessionConflictError', async () => {
    const fake = new InMemorySessionStorage()
    await saveSessionTo(fake, 's1', [{ id: 'm0', role: 'user', content: 'seed' } as any],
      { cwd: '/w', model: 'm' }, { expectedRevision: null })          // revision 1
    const agent = new Agent(base({ persistSession: true, sessionStorage: fake, resume: 's1' }))
    await (agent as any).setupDone
    // external writer (another process) bumps to 2 — AFTER the agent's resume load
    const cur = fake.store.get('s1')!
    await saveSessionTo(fake, 's1', cur.messages, cur.metadata, { expectedRevision: 1 })
    ;(agent as any).history = [{ id: 'm1', role: 'user', content: 'x' }]
    await expect((agent as any).persistCheckpoint()).rejects.toThrow(SessionConflictError)
  })

  it('best-effort mode never CAS-checks even with a custom storage override', async () => {
    const fake = new InMemorySessionStorage()
    const agent = new Agent(base({ persistSession: true, sessionStorage: fake, sessionErrorMode: 'best-effort' }))
    ;(agent as any).history = [{ id: 'm1', role: 'user', content: 'x' }]
    await (agent as any).persistCheckpoint()
    expect(fake.saveCalls[0].opts).toBeUndefined()
  })
})

// Deterministic in-flight error: mock the engine's submitMessage to throw.
// vi.mock is hoisted file-wide; the close/validation tests above never touch
// submitMessage, so they are unaffected.
vi.mock('./engine.js', async (importOriginal) => {
  const actual = await importOriginal() as any
  return {
    ...actual,
    QueryEngine: class extends actual.QueryEngine {
      async *submitMessage(): AsyncGenerator<any> {
        throw new Error('engine boom')
      }
    },
  }
})

describe('query() finally masking guard (issue #4 spec §7)', () => {
  it('strict save failure does NOT mask the original query error; both observed', async () => {
    const fake = new InMemorySessionStorage()
    fake.failSaves = true
    const logs: unknown[][] = []
    const agent = new Agent(base({
      persistSession: true,
      sessionStorage: fake,
      logger: { debug() {}, info() {}, warn() {}, error: (...a: unknown[]) => { logs.push(a) } } as any,
    }))
    ;(agent as any).history = [{ id: 'seed', role: 'user', content: 's' }]
    await expect(agent.prompt('hi')).rejects.toThrow('engine boom')   // ORIGINAL error wins
    expect(logs.some((a) => String(a[0]).includes('[session] checkpoint failed'))).toBe(true)
  })

  it('healthy save + engine error → only the engine error surfaces', async () => {
    const fake = new InMemorySessionStorage()
    const agent = new Agent(base({ persistSession: true, sessionStorage: fake }))
    ;(agent as any).history = [{ id: 'seed', role: 'user', content: 's' }]
    await expect(agent.prompt('hi')).rejects.toThrow('engine boom')
    expect(fake.saveCalls.length).toBeGreaterThanOrEqual(1)           // checkpoint still ran in finally
  })
})

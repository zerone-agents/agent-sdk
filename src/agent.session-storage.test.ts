import { describe, expect, it, vi } from 'vitest'
import { Agent } from './agent.js'
import type { AgentOptions, SDKMessage } from './types.js'
import { InMemorySessionStorage } from './session-storage-fake.js'
import { FileSessionStorage, SessionConflictError, SessionNotFoundError, saveSessionTo, type SessionStorage } from './session-storage.js'
import type { NormalizedMessageParam } from './providers/types.js'
import type { Logger } from './utils/logger.js'

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

/**
 * Typed test seam for Agent internals under test. The fields are private at
 * runtime; this structured cast documents exactly what the tests touch
 * (CONTRIBUTING: no unjustified `any`).
 */
interface AgentInternals {
  history: NormalizedMessageParam[]
  setupDone: Promise<void>
  persistCheckpoint(): Promise<void>
}
function internals(agent: Agent): AgentInternals {
  return agent as unknown as AgentInternals
}

/** User message with a stable id (matches the persisted transcript shape). */
function histMsg(id: string, text: string): NormalizedMessageParam {
  return { id, role: 'user', content: text } as NormalizedMessageParam
}

/** Logger stub capturing error() output for sink assertions. */
function capturingLogger(logs: unknown[][]): Logger {
  return {
    debug: () => {},
    trace: () => {},
    error: (...args: unknown[]) => { logs.push(args) },
    child: () => capturingLogger(logs),
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
    internals(agent).history = [histMsg('m1', 'x')]
    const t0 = Date.now()
    await agent.close()
    expect(Date.now() - t0).toBeLessThan(2000)
    release()                                     // let the background write settle; no unhandled rejection
  })

  it('history checkpoint goes through the injected storage', async () => {
    const fake = new InMemorySessionStorage()
    const agent = new Agent(base({ persistSession: true, sessionStorage: fake }))
    internals(agent).history = [histMsg('m1', 'x')]
    await agent.close()
    expect(fake.saveCalls.map((c) => c.sessionId)).toHaveLength(1)
    // custom storage without explicit mode → strict (spec §7 inference);
    // new session → first checkpoint is create-only (expectedRevision: null).
    // The explicit best-effort override is covered by the CAS tests below.
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
    await saveSessionTo(fake, 's1', [histMsg('m0', 'seed')],
      { cwd: '/w', model: 'm' }, { expectedRevision: null })          // revision 1 (saveCalls[0])
    const agent = new Agent(base({ persistSession: true, sessionStorage: fake, resume: 's1' }))
    await internals(agent).setupDone
    internals(agent).history = [histMsg('m1', 'x')]
    await internals(agent).persistCheckpoint()
    expect(fake.saveCalls[1].opts?.expectedRevision).toBe(1)           // CAS-matched the loaded revision
    expect(fake.store.get('s1')!.metadata.revision).toBe(2)
    internals(agent).history = [histMsg('m2', 'y')]
    await internals(agent).persistCheckpoint()
    expect(fake.saveCalls[2].opts?.expectedRevision).toBe(2)           // bumped and re-matched
    expect(fake.store.get('s1')!.metadata.revision).toBe(3)
    // createdAt stability: both checkpoints reuse the loaded value
    expect(fake.saveCalls[1].metadata.createdAt).toBe(fake.saveCalls[2].metadata.createdAt)
    expect(fake.saveCalls[1].metadata.createdAt).toBe(fake.store.get('s1')!.metadata.createdAt)
  })

  it('external writer advances revision → next checkpoint throws SessionConflictError', async () => {
    const fake = new InMemorySessionStorage()
    await saveSessionTo(fake, 's1', [histMsg('m0', 'seed')],
      { cwd: '/w', model: 'm' }, { expectedRevision: null })          // revision 1
    const agent = new Agent(base({ persistSession: true, sessionStorage: fake, resume: 's1' }))
    await internals(agent).setupDone
    // external writer (another process) bumps to 2 — AFTER the agent's resume load
    const cur = fake.store.get('s1')!
    await saveSessionTo(fake, 's1', cur.messages, cur.metadata, { expectedRevision: 1 })
    internals(agent).history = [histMsg('m1', 'x')]
    await expect(internals(agent).persistCheckpoint()).rejects.toThrow(SessionConflictError)
  })

  it('best-effort mode never CAS-checks even with a custom storage override', async () => {
    const fake = new InMemorySessionStorage()
    const agent = new Agent(base({ persistSession: true, sessionStorage: fake, sessionErrorMode: 'best-effort' }))
    internals(agent).history = [histMsg('m1', 'x')]
    await internals(agent).persistCheckpoint()
    expect(fake.saveCalls[0].opts).toBeUndefined()
  })
})

// Deterministic in-flight error: mock the engine's submitMessage to throw.
// vi.mock is hoisted file-wide; the close/validation tests above never touch
// submitMessage, so they are unaffected.
vi.mock('./engine.js', async (importOriginal) => {
  const actual = await importOriginal() as { QueryEngine: new (...args: unknown[]) => object }
  return {
    ...actual,
    QueryEngine: class extends actual.QueryEngine {
      async *submitMessage(): AsyncGenerator<SDKMessage> {
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
      logger: capturingLogger(logs),
    }))
    internals(agent).history = [histMsg('seed', 's')]
    await expect(agent.prompt('hi')).rejects.toThrow('engine boom')   // ORIGINAL error wins
    expect(logs.some((a) => String(a[0]).includes('[session] checkpoint failed'))).toBe(true)
  })

  it('healthy save + engine error → only the engine error surfaces', async () => {
    const fake = new InMemorySessionStorage()
    const agent = new Agent(base({ persistSession: true, sessionStorage: fake }))
    internals(agent).history = [histMsg('seed', 's')]
    await expect(agent.prompt('hi')).rejects.toThrow('engine boom')
    expect(fake.saveCalls.length).toBeGreaterThanOrEqual(1)           // checkpoint still ran in finally
  })
})

describe('tag preservation across checkpoints (issue #4 PR review)', () => {
  it('tag survives Agent resume + checkpoint', async () => {
    const fake = new InMemorySessionStorage()
    await saveSessionTo(fake, 's1', [histMsg('m0', 'seed')],
      { cwd: '/w', model: 'm', tag: 'important' }, { expectedRevision: null })
    const agent = new Agent(base({ persistSession: true, sessionStorage: fake, resume: 's1' }))
    await internals(agent).setupDone
    internals(agent).history = [histMsg('m1', 'more')]
    await internals(agent).persistCheckpoint()
    expect(fake.store.get('s1')!.metadata.tag).toBe('important')
  })
})

describe('Agent todo-storage validation (issue #128)', () => {
  it('custom storage without loadTodos/saveTodos → TypeError at construction', () => {
    const storage = { load: async () => null, save: async () => {} } as unknown as SessionStorage
    expect(() => new Agent(base({ sessionStorage: storage }))).toThrow(TypeError)
  })

  it('FileSessionStorage passes validation', () => {
    expect(() => new Agent(base({ sessionStorage: new FileSessionStorage() }))).not.toThrow()
  })
})

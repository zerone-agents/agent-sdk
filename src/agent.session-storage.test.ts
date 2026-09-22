import { describe, expect, it } from 'vitest'
import { Agent } from './agent.js'
import type { AgentOptions } from './types.js'
import { InMemorySessionStorage } from './session-storage-fake.js'

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
    // best-effort mode: no CAS opts (spec §7 — legacy upsert semantics)
    expect(fake.saveCalls[0].opts?.expectedRevision).toBeUndefined()
  })
})

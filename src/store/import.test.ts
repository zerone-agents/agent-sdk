import { describe, expect, it } from 'vitest'
import { importLegacySession } from './import.js'
import { InMemorySessionStore } from './in-memory.js'
import { WriteCoordinator } from './coordinator.js'
import type { SessionData } from '../session.js'

const legacy = (msgs: Array<{ id: string; content: string }>, revision?: number): SessionData => ({
  metadata: {
    id: 'legacy-1', cwd: '/tmp', model: 'm',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    messageCount: msgs.length,
    ...(revision !== undefined ? { revision } : {}),
  },
  messages: msgs.map((m) => ({ id: m.id, role: 'user' as const, content: m.content })),
})

describe('importLegacySession (issue #131 P3 T7, review R10)', () => {
  it('imports a legacy archive atomically → imported report + readable session', async () => {
    const store = new InMemorySessionStore()
    const reader = async (sid: string) =>
      (sid === 'legacy-1' ? legacy([{ id: 'm1', content: 'hello' }, { id: 'm2', content: 'world' }], 3) : null)
    const report = await importLegacySession({ store, legacyReader: reader }, 'legacy-1')
    expect(report.status).toBe('imported')
    if (report.status !== 'imported') return
    expect(report.messageCount).toBe(2)
    expect(report.revision).toBe(3)   // initialRevision preserved (§8.3)
    const state = await store.loadSession('legacy-1')
    expect(state).not.toBeNull()
    const msgs = await store.loadContext('legacy-1', 'b1')
    expect(msgs).toHaveLength(2)
    expect((msgs[0] as { content: string }).content).toBe('hello')
  })

  it('skips when the target session already exists (idempotent)', async () => {
    const store = new InMemorySessionStore()
    const coord = new WriteCoordinator({ store })
    await coord.execute('legacy-1', { kind: 'register', ownership: { rootSessionId: 'legacy-1' } })
    const report = await importLegacySession({ store, legacyReader: async () => legacy([{ id: 'm1', content: 'x' }]) }, 'legacy-1')
    expect(report).toMatchObject({ status: 'skipped', reason: 'already-exists', existingRevision: 0 })
  })

  it('fails (not throws) when the legacy archive is missing', async () => {
    const store = new InMemorySessionStore()
    const report = await importLegacySession({ store, legacyReader: async () => null }, 'ghost')
    expect(report).toMatchObject({ status: 'failed', reason: 'legacy archive not found' })
  })

  it('read errors surface as failed reports (batch migration can continue)', async () => {
    const store = new InMemorySessionStore()
    const report = await importLegacySession({ store, legacyReader: async () => { throw new Error('corrupt archive') } }, 'bad')
    expect(report.status).toBe('failed')
    if (report.status === 'failed') expect(report.reason).toContain('corrupt archive')
  })
})
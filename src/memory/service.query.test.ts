import { describe, expect, it, vi } from 'vitest'
import { createMemoryService } from './service.js'
import { InMemoryMemoryStorage } from './in-memory-storage.js'
import { createDiagnosticsSink } from '../utils/diagnostics.js'
import type { MemoryEvent } from './events.js'

describe('session.search', () => {
  it('searches active+archived across global/user/bound workspace, ranked deterministically', async () => {
    const service = createMemoryService({ storage: new InMemoryMemoryStorage() })
    await service.start()
    const s = await service.bind({ actor: 'session', workspace: '/repo/a' })
    await s.add({ scope: 'global', content: '部署在阿里云 ECS 上', importance: 75 })
    const low = await s.add({ scope: 'user', content: '阿里云相关笔记', importance: 25 })
    await s.add({ scope: 'workspace', content: 'ECS 部署笔记', importance: 50 })
    await service.admin.mutate(
      { type: 'archive', recordId: low.record!.id, expectedRevision: 1 }, { actor: 'host' })

    const hits = await s.search({ text: '阿里云 ecs' })
    // '阿里云 ecs' matches ONLY the global record (complete): the workspace
    // record normalizes to 'ecs 部署笔记', which contains neither the complete
    // query nor every term ('阿里云' is absent), and the user record lacks
    // 'ecs' entirely.
    expect(hits.map((r) => r.scope)).toEqual(['global'])

    const termHits = await s.search({ text: '笔记' })
    // Both remaining readable records are complete matches; tie-break is
    // importance desc: workspace(50, active) before user(25, archived).
    expect(termHits.map((r) => [r.scope, r.status])).toEqual([['workspace', 'active'], ['user', 'archived']])
    await service.stop()
  })

  it('excludes deleted records and foreign workspaces', async () => {
    const service = createMemoryService({ storage: new InMemoryMemoryStorage() })
    await service.start()
    const a = await service.bind({ actor: 'session', workspace: '/repo/a' })
    const b = await service.bind({ actor: 'session', workspace: '/repo/b' })
    const foreign = await b.add({ scope: 'workspace', content: 'shared-keyword from b', importance: 50 })
    const mine = await a.add({ scope: 'workspace', content: 'shared-keyword from a', importance: 50 })
    await a.remove(mine.record!.id, 1)
    const hits = await a.search({ text: 'shared-keyword' })
    expect(hits).toEqual([])
    expect(foreign.record!.id).toBeDefined()
    await service.stop()
  })

  it('empty query returns []; limit is validated', async () => {
    const service = createMemoryService({ storage: new InMemoryMemoryStorage() })
    await service.start()
    const s = await service.bind({ actor: 'session' })
    await s.add({ scope: 'global', content: 'x', importance: 50 })
    expect(await s.search({ text: '   ' })).toEqual([])
    await expect(s.search({ text: 'x', limit: 0 })).rejects.toThrow(/limit/i)
    await service.stop()
  })
})

describe('session.renderContext', () => {
  it('renders only active records from readable scopes via the canonical renderer', async () => {
    const service = createMemoryService({ storage: new InMemoryMemoryStorage() })
    await service.start()
    const s = await service.bind({ actor: 'session', workspace: '/repo/a' })
    await s.add({ scope: 'global', content: 'g', importance: 50 })
    const archived = await s.add({ scope: 'user', content: 'hidden', importance: 50 })
    await service.admin.mutate(
      { type: 'archive', recordId: archived.record!.id, expectedRevision: 1 }, { actor: 'host' })
    const out = await s.renderContext()
    expect(out).toContain('<global_memory')
    expect(out).toContain('>g</record>')
    expect(out).not.toContain('hidden')
    expect(out).not.toContain('workspace_memory') // bound but empty → omitted
    await service.stop()
  })
})

describe('events + diagnostics', () => {
  it('emits MemoryEvent after commit; a throwing sink does not change the result', async () => {
    const events: MemoryEvent[] = []
    const diag = createDiagnosticsSink()
    const error = vi.spyOn(diag, 'error')
    const service = createMemoryService({
      storage: new InMemoryMemoryStorage(),
      diagnostics: diag,
      events: (e) => { events.push(e); if (events.length === 2) throw new Error('sink exploded') },
    })
    await service.start()
    const s = await service.bind({ actor: 'session', sessionId: 's1' })
    await s.add({ scope: 'global', content: 'first', importance: 50 })
    const second = await s.add({ scope: 'global', content: 'second', importance: 50 }) // sink throws here
    expect(second.record!.content).toBe('second') // commit already durable → success
    expect(events).toHaveLength(2)
    expect(error).toHaveBeenCalled() // safeError route: raw cause via the cause channel, never interpolated
    expect(events[0]!.context.sessionId).toBe('s1')
    await service.stop()
  })
})
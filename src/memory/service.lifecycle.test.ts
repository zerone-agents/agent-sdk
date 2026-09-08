import { describe, expect, it } from 'vitest'
import { createMemoryService } from './service.js'
import { InMemoryMemoryStorage } from './in-memory-storage.js'
import {
  MemoryAccessError,
  MemoryServiceUnavailableError,
} from './errors.js'

function makeService() {
  const storage = new InMemoryMemoryStorage()
  const service = createMemoryService({ storage })
  return { service, storage }
}

describe('lifecycle', () => {
  it('rejects bind before start with method+phase', async () => {
    const { service } = makeService()
    await expect(service.bind({ actor: 'session' })).rejects.toSatisfy(
      (e) => e instanceof MemoryServiceUnavailableError && e.method === 'bind' && e.phase === 'stopped',
    )
  })

  it('concurrent start() calls share one transition; stop() rejects new ops', async () => {
    const { service } = makeService()
    await Promise.all([service.start(), service.start()])
    const session = await service.bind({ actor: 'session' })
    const stop = service.stop()
    // stop() publishes stopping intent synchronously:
    await expect(service.bind({ actor: 'session' })).rejects.toThrow(MemoryServiceUnavailableError)
    await stop
    await expect(session.renderContext()).rejects.toThrow(MemoryServiceUnavailableError)
  })

  it('restart after stop works', async () => {
    const { service } = makeService()
    await service.start()
    await service.stop()
    await service.start()
    await expect(service.bind({ actor: 'session' })).resolves.toBeDefined()
    await service.stop()
  })
})

describe('bind + access isolation', () => {
  it('registers a workspace idempotently; queryWorkspaces sorted by canonicalPath', async () => {
    const { service } = makeService()
    await service.start()
    await service.bind({ actor: 'session', workspace: '/repo/b' })
    await service.bind({ actor: 'session', workspace: '/repo/a' })
    await service.bind({ actor: 'session', workspace: '/repo/b' }) // idempotent
    const workspaces = await service.admin.queryWorkspaces()
    expect(workspaces.map((w) => w.canonicalPath)).toEqual(['/repo/a', '/repo/b'])
    expect(workspaces[1]!.id).toHaveLength(64)
    await service.stop()
  })

  it('workspace-scoped operations without a bound workspace reject with MemoryAccessError', async () => {
    const { service } = makeService()
    await service.start()
    const session = await service.bind({ actor: 'session' })
    await expect(session.add({ scope: 'workspace', content: 'x', importance: 50 }))
      .rejects.toThrow(MemoryAccessError)
    await service.stop()
  })

  it('writableScopes policy restricts writes but never reads', async () => {
    const { service } = makeService()
    await service.start()
    const session = await service.bind({ actor: 'session' }, { writableScopes: ['workspace'] })
    await expect(session.add({ scope: 'global', content: 'x', importance: 50 }))
      .rejects.toThrow(MemoryAccessError)
    await service.stop()
  })

  it('stop() drains in-flight bind registrations before closing storage (P1-4)', async () => {
    const { service } = makeService()
    await service.start()
    const bindPromise = service.bind({ actor: 'session', workspace: '/repo/z' })
    const stopPromise = service.stop() // synchronously publishes stopping intent
    // The bind was ADMITTED before stop: its registration must complete —
    // no "closed storage" error — because stop drains the admission chain.
    await expect(bindPromise).resolves.toBeDefined()
    await stopPromise
  })
})
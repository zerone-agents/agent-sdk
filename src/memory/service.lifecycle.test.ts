import { describe, expect, it } from 'vitest'
import { createMemoryService } from './service.js'
import { InMemoryMemoryStorage } from './in-memory-storage.js'
import type {
  MemoryStorage,
  MemoryStorageAuditQuery,
  MemoryStorageCommit,
  MemoryStorageRecordQuery,
} from './storage.js'
import type { MemoryAuditEvent, MemoryRecord, MemoryWorkspace } from './types.js'
import {
  MemoryAccessError,
  MemoryServiceUnavailableError,
} from './errors.js'

function makeService() {
  const storage = new InMemoryMemoryStorage()
  const service = createMemoryService({ storage })
  return { service, storage }
}

/**
 * Test seam: open() stays pending until completeOpen() is called, so a start
 * body can be held in-flight while the test races a stop() against it.
 * Records close() invocations; everything else delegates to an in-memory store.
 */
class SlowOnOpenStorage implements MemoryStorage {
  closeCalls = 0
  private readonly inner = new InMemoryMemoryStorage()
  private openCompleter: (() => void) | null = null
  private readonly openStartedWaiters: (() => void)[] = []

  open(): Promise<void> {
    this.openStartedWaiters.splice(0).forEach((resolve) => resolve())
    return new Promise<void>((resolve) => {
      this.openCompleter = () => resolve()
    })
  }

  /** Test handle: resolves the pending open() so the start body resumes. */
  completeOpen(): void {
    this.openCompleter?.()
    this.openCompleter = null
  }

  /** Test handle: resolves once open() has been invoked (start body in-flight). */
  whenOpenStarted(): Promise<void> {
    if (this.openCompleter !== null) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.openStartedWaiters.push(resolve)
    })
  }

  close(): Promise<void> {
    this.closeCalls++
    return this.inner.close()
  }

  ensureWorkspace(workspace: MemoryWorkspace): Promise<void> {
    return this.inner.ensureWorkspace(workspace)
  }

  scanWorkspaces(): AsyncIterable<MemoryWorkspace> {
    return this.inner.scanWorkspaces()
  }

  getRecord(recordId: string): Promise<MemoryRecord | null> {
    return this.inner.getRecord(recordId)
  }

  scanRecords(query: MemoryStorageRecordQuery): AsyncIterable<MemoryRecord> {
    return this.inner.scanRecords(query)
  }

  commit(commit: MemoryStorageCommit): Promise<void> {
    return this.inner.commit(commit)
  }

  scanAudit(query: MemoryStorageAuditQuery): AsyncIterable<MemoryAuditEvent> {
    return this.inner.scanAudit(query)
  }
}

/**
 * Test seam: open() throws exactly once, then delegates normally — proves a
 * failed open must not poison the lifecycle chain (restart stays reachable).
 */
class FailFirstOpenStorage implements MemoryStorage {
  private readonly inner = new InMemoryMemoryStorage()
  private openCalls = 0

  open(): Promise<void> {
    this.openCalls++
    if (this.openCalls === 1) return Promise.reject(new Error('open boom'))
    return this.inner.open()
  }

  /** Test accessor (PR review P2): how many times open() was invoked. */
  getOpenCalls(): number {
    return this.openCalls
  }

  close(): Promise<void> {
    return this.inner.close()
  }

  ensureWorkspace(workspace: MemoryWorkspace): Promise<void> {
    return this.inner.ensureWorkspace(workspace)
  }

  scanWorkspaces(): AsyncIterable<MemoryWorkspace> {
    return this.inner.scanWorkspaces()
  }

  getRecord(recordId: string): Promise<MemoryRecord | null> {
    return this.inner.getRecord(recordId)
  }

  scanRecords(query: MemoryStorageRecordQuery): AsyncIterable<MemoryRecord> {
    return this.inner.scanRecords(query)
  }

  commit(commit: MemoryStorageCommit): Promise<void> {
    return this.inner.commit(commit)
  }

  scanAudit(query: MemoryStorageAuditQuery): AsyncIterable<MemoryAuditEvent> {
    return this.inner.scanAudit(query)
  }
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

  it('stop-during-start: start completion must not override the published stopping intent', async () => {
    const storage = new SlowOnOpenStorage()
    const service = createMemoryService({ storage })

    // Prime a session handle while the service is genuinely running.
    const warmup = service.start()
    await storage.whenOpenStarted() // body in-flight on open()
    storage.completeOpen()
    await warmup
    const session = await service.bind({ actor: 'session' })
    await service.stop()

    // Race: stop() publishes 'stopping' synchronously while start's body is
    // still awaiting open(). If the resumed start body blindly flipped the
    // phase back to 'running', an op admitted in that window would escape the
    // stop drain and either run after storage.close() (raw storage error) or
    // silently succeed — instead of rejecting with the stopping payload.
    const start = service.start()
    await storage.whenOpenStarted() // phase === 'starting', body pending on open()
    const stop = service.stop()     // synchronous intent publication → 'stopping'
    storage.completeOpen()          // start body resumes
    await start

    // start completion MUST NOT have flipped phase back to 'running': a bind
    // issued right away rejects cleanly with the 'stopping' payload, instead
    // of being admitted past the drain.
    const bindDuringStop = service.bind({ actor: 'session' })
    await expect(bindDuringStop).rejects.toSatisfy(
      (e) => e instanceof MemoryServiceUnavailableError && e.method === 'bind' && e.phase === 'stopping',
    )

    await stop
    expect(storage.closeCalls).toBe(2) // each stop drained then closed
    // After the drain + close, every operation rejects with the 'stopped' payload.
    await expect(session.add({ scope: 'global', content: 'x', importance: 50 })).rejects.toSatisfy(
      (e) => e instanceof MemoryServiceUnavailableError && e.method === 'add' && e.phase === 'stopped',
    )
    await expect(service.bind({ actor: 'session' })).rejects.toSatisfy(
      (e) => e instanceof MemoryServiceUnavailableError && e.method === 'bind' && e.phase === 'stopped',
    )
  })

  it('stop() published synchronously before the queued start body runs: final phase is stopped', async () => {
    // start() only QUEUES its body on the lifecycle chain; stop() flips the
    // phase to 'stopping' synchronously before that body ever enters. The
    // queued start body must not run open() nor overwrite the newer stop
    // intent — service ends 'stopped' with storage closed, never a silent
    // post-close admit.
    const { service } = makeService()
    const start = service.start() // body queued, not yet entered
    const stop = service.stop()   // sync flip lands before the body enters
    await start
    await stop
    await expect(service.bind({ actor: 'session' })).rejects.toSatisfy(
      (e) => e instanceof MemoryServiceUnavailableError && e.phase === 'stopped',
    )
  })

  it('failed open() must not poison the lifecycle chain: a later start() restarts normally', async () => {
    const storage = new FailFirstOpenStorage()
    const service = createMemoryService({ storage })
    await expect(service.start()).rejects.toThrow('open boom')
    // The failing transition must leave the chain alive (error swallowed in
    // the tail while phase resets to 'stopped'): restart — not a stale
    // rejection carrying the old error — follows.
    await service.start()
    await expect(service.bind({ actor: 'session' })).resolves.toBeDefined()
    await service.stop()
  })

  it('concurrent start() callers share the same failure and open() runs once (PR review P2)', async () => {
    const storage = new FailFirstOpenStorage()
    const service = createMemoryService({ storage })
    const p1 = service.start()
    const p2 = service.start() // in-flight: must share p1's outcome
    await expect(p1).rejects.toThrow('open boom')
    await expect(p2).rejects.toThrow('open boom') // was: fulfilled via a second queued body
    expect(storage.getOpenCalls()).toBe(1) // only ONE transition body ran
    // Recovery: a later start() re-runs a FRESH transition and succeeds.
    await service.start()
    await expect(service.bind({ actor: 'session' })).resolves.toBeDefined()
    await service.stop()
  })

  it('concurrent stop() callers share the same outcome even when close fails (round-6 P2)', async () => {
    const storage = new InMemoryMemoryStorage()
    let closeCalls = 0
    const originalClose = storage.close.bind(storage)
    storage.close = async () => {
      closeCalls += 1
      if (closeCalls === 1) throw new Error('close boom')
      return originalClose()
    }
    const service = createMemoryService({ storage })
    await service.start()
    const p1 = service.stop()
    const p2 = service.stop() // in-flight: must share p1's outcome
    await expect(p1).rejects.toThrow('close boom')
    await expect(p2).rejects.toThrow('close boom') // was: fulfilled via the swallowed tail
    // Recovery: a later stop() re-issues the transition and succeeds.
    await expect(service.stop()).resolves.toBeUndefined()
    expect(closeCalls).toBe(2)
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

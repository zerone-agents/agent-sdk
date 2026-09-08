import type { MemoryStorage } from './storage.js'
import type { MemoryAuditEvent, MemoryRecord, MemoryWorkspace } from './types.js'

export interface MemoryStorageConformanceHooks {
  /** Enables the injected-failure test: next commit() must reject without applying anything. */
  failNextCommit?: (storage: MemoryStorage, error: Error) => void
  /** Enables the durability test: re-open a fresh instance over the SAME data root. */
  reopen?: () => Promise<MemoryStorage>
}

function rec(id: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id, scope: 'global' as const, workspaceId: null, content: `content-${id}`,
    importance: 50 as const, status: 'active' as const, revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null, ...overrides,
  }
}

function audit(id: string, recordId: string, overrides: Partial<MemoryAuditEvent> = {}): MemoryAuditEvent {
  return {
    id, recordId, scope: 'global' as const, workspaceId: null, operation: 'create' as const,
    expectedRevision: null, committedRevision: 1, beforeContent: null, afterContent: 'c',
    actor: 'host' as const, committedAt: '2026-01-01T00:00:00.000Z', ...overrides,
  }
}

const ws = (id: string, canonicalPath = `/repo/${id}`): MemoryWorkspace => ({ id, canonicalPath })

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of iter) out.push(item)
  return out
}

/**
 * Reusable adapter conformance suite (issue #61). Register inside a test file:
 * `await runMemoryStorageConformance('Name', () => new MyStorage(), hooks?)`.
 * Storage CONTRACT tests only — MemoryService behavior has its own seam tests.
 *
 * TEST INFRASTRUCTURE: vitest is imported lazily at call time, so importing
 * the package root never requires vitest (the SDK ships no vitest dependency);
 * consumers running this suite must install vitest themselves. Returns a
 * promise — `await` it at the top level of a vitest test file.
 */
export async function runMemoryStorageConformance(
  name: string,
  factory: () => MemoryStorage | Promise<MemoryStorage>,
  hooks: MemoryStorageConformanceHooks = {},
): Promise<void> {
  const { describe, expect, it } = await import('vitest')
  describe(`MemoryStorage conformance: ${name}`, () => {
    async function withFresh<T>(fn: (storage: MemoryStorage) => Promise<T>): Promise<T> {
      const storage = await factory()
      await storage.open() // enter the open lifecycle (brief omission; required by the port contract)
      try {
        return await fn(storage)
      } finally {
        await storage.close()
      }
    }

    it('rejects calls outside the open lifecycle', async () => {
      const storage = await factory()
      await expect(storage.getRecord('x')).rejects.toThrow(/open/i)
      await expect(storage.commit({})).rejects.toThrow(/open/i)
      await expect(collect(storage.scanRecords({}))).rejects.toThrow(/open/i)
      await expect(storage.ensureWorkspace(ws('w1'))).rejects.toThrow(/open/i)
      await storage.open()
      await storage.close()
      await expect(storage.getRecord('x')).rejects.toThrow(/open/i)
    })

    it('registers workspaces idempotently and scans them deterministically', async () => {
      await withFresh(async (storage) => {
        await storage.ensureWorkspace(ws('w1'))
        await storage.ensureWorkspace(ws('w1')) // idempotent
        await storage.ensureWorkspace(ws('w2', '/repo/two'))
        expect(await collect(storage.scanWorkspaces())).toEqual([ws('w1'), ws('w2', '/repo/two')])
      })
    })

    it('round-trips records with all fields intact', async () => {
      await withFresh(async (storage) => {
        const record = rec('r1', { content: '<full> & "round" trip', importance: 75, status: 'archived', revision: 3 })
        await storage.commit({ insertRecords: [record] })
        expect(await storage.getRecord('r1')).toEqual(record) // snapshot deep-equals the input
      })
    })

    it('ownership isolation: mutating caller/returned objects cannot corrupt storage (R4-P2)', async () => {
      await withFresh(async (storage) => {
        const input = rec('r1')
        await storage.commit({ insertRecords: [input] })
        input.content = 'mutated-after-commit' // mutate the ORIGINAL input
        expect((await storage.getRecord('r1'))!.content).toBe('content-r1') // write-time copy held

        const returned = await storage.getRecord('r1')
        returned!.content = 'mutated-after-read'
        expect((await storage.getRecord('r1'))!.content).toBe('content-r1') // read snapshots

        const event = audit('e1', 'r1')
        await storage.commit({ appendAudit: [event] })
        event.afterContent = 'mutated-audit'
        let events = await collect(storage.scanAudit({ recordId: 'r1' }))
        expect(events[0]!.afterContent).toBe('c')
        events[0]!.afterContent = 'mutated-scan-result'
        events = await collect(storage.scanAudit({ recordId: 'r1' }))
        expect(events[0]!.afterContent).toBe('c')

        await storage.ensureWorkspace(ws('w1'))
        const [registered] = await collect(storage.scanWorkspaces())
        registered!.canonicalPath = '/mutated'
        expect((await collect(storage.scanWorkspaces()))[0]!.canonicalPath).toBe('/repo/w1')
      })
    })

    it('applies multi-record and multi-audit commits atomically', async () => {
      await withFresh(async (storage) => {
        await storage.commit({ insertRecords: [rec('a'), rec('b')], appendAudit: [audit('e1', 'a')] })
        expect((await storage.getRecord('a'))?.id).toBe('a')
        expect(await collect(storage.scanRecords({}))).toHaveLength(2)
        expect(await collect(storage.scanAudit({}))).toEqual([audit('e1', 'a')])
        await storage.commit({ replaceRecords: [rec('a', { content: 'v2', revision: 2 })], appendAudit: [audit('e2', 'a')] })
        expect((await storage.getRecord('a'))).toMatchObject({ content: 'v2', revision: 2 })
        expect(await collect(storage.scanAudit({}))).toHaveLength(2)
      })
    })

    it('injected commit failure leaves zero partial visibility', async () => {
      if (!hooks.failNextCommit) return
      await withFresh(async (storage) => {
        await storage.commit({ insertRecords: [rec('seed')], appendAudit: [audit('e0', 'seed')] })
        hooks.failNextCommit!(storage, new Error('disk on fire'))
        await expect(storage.commit({
          insertRecords: [rec('lost')],
          replaceRecords: [rec('seed', { content: 'mutated', revision: 2 })],
          appendAudit: [audit('e1', 'seed')],
        })).rejects.toThrow('disk on fire')
        expect(await storage.getRecord('lost')).toBeNull()
        expect(await storage.getRecord('seed')).toMatchObject({ content: 'content-seed', revision: 1 })
        expect(await collect(storage.scanAudit({}))).toEqual([audit('e0', 'seed')])
      })
    })

    it('redacts audit content and deletes audit events by id', async () => {
      await withFresh(async (storage) => {
        await storage.commit({ insertRecords: [rec('r1')], appendAudit: [audit('e1', 'r1'), audit('e2', 'r1')] })
        await storage.commit({ redactAuditForRecords: ['r1'], deleteAuditIds: ['e2'] })
        const events = await collect(storage.scanAudit({}))
        expect(events).toHaveLength(1)
        expect(events[0]!.beforeContent).toBeNull()
        expect(events[0]!.afterContent).toBeNull()
      })
    })

    it('scanRecords filters deterministically by scope, workspaceId and statuses', async () => {
      await withFresh(async (storage) => {
        await storage.commit({
          insertRecords: [
            rec('g', { scope: 'global' }),
            rec('u', { scope: 'user' }),
            rec('w', { scope: 'workspace', workspaceId: 'ws1' }),
            rec('old', { status: 'archived' }),
          ],
        })
        expect((await collect(storage.scanRecords({ workspaceId: 'ws1' }))).map((r) => r.id)).toEqual(['w'])
        expect((await collect(storage.scanRecords({ scope: 'user' }))).map((r) => r.id)).toEqual(['u'])
        expect(await collect(storage.scanRecords({ statuses: ['active', 'archived'] }))).toHaveLength(4)
        expect((await collect(storage.scanRecords({ statuses: ['active'] }))).map((r) => r.id).sort())
          .toEqual(['g', 'u', 'w'])
      })
    })

    it('durability: committed data survives close + reopen', async () => {
      if (!hooks.reopen) return
      // Real adapters: drive open/commit/close on ONE instance, then reopen
      // over the same data root via the hook.
      const a = await factory()
      await a.open()
      await a.ensureWorkspace(ws('w1'))
      await a.commit({ insertRecords: [rec('persist')], appendAudit: [audit('e1', 'persist')] })
      await a.close()
      const b = await hooks.reopen()
      await b.open()
      expect(await collect(b.scanWorkspaces())).toEqual([ws('w1')])
      expect((await b.getRecord('persist'))?.id).toBe('persist')
      expect(await collect(b.scanAudit({}))).toEqual([audit('e1', 'persist')])
      await b.close()
    })
  })
}

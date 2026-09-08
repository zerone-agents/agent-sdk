import { describe, expect, it } from 'vitest'
import { InMemoryMemoryStorage } from './in-memory-storage.js'
import type { MemoryRecord } from './types.js'

function rec(partial: Partial<MemoryRecord> & { id: string }): MemoryRecord {
  return {
    scope: 'global', workspaceId: null, content: 'c', importance: 50,
    status: 'active', revision: 1, createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z', deletedAt: null, ...partial,
  }
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of iter) out.push(item)
  return out
}

describe('InMemoryMemoryStorage', () => {
  it('rejects calls before open()', async () => {
    const s = new InMemoryMemoryStorage()
    await expect(s.getRecord('x')).rejects.toThrow(/open/i)
    await expect(s.commit({})).rejects.toThrow(/open/i)
  })

  it('round-trips records and applies commits atomically', async () => {
    const s = new InMemoryMemoryStorage()
    await s.open()
    await s.commit({ insertRecords: [rec({ id: 'a' }), rec({ id: 'b', scope: 'user' })] })
    expect((await s.getRecord('a'))?.id).toBe('a')
    expect(await collect(s.scanRecords({ statuses: ['active'] }))).toHaveLength(2)
    await s.commit({ replaceRecords: [rec({ id: 'a', revision: 2, content: 'c2' })] })
    expect((await s.getRecord('a'))?.revision).toBe(2)
    await s.close()
  })

  it('injected commit failure leaves no partial visibility', async () => {
    const s = new InMemoryMemoryStorage()
    await s.open()
    await s.commit({ insertRecords: [rec({ id: 'keep' })] })
    s.failNextCommit(new Error('disk full'))
    await expect(
      s.commit({ insertRecords: [rec({ id: 'lost' })], replaceRecords: [rec({ id: 'keep', revision: 9 })] }),
    ).rejects.toThrow('disk full')
    expect(await s.getRecord('lost')).toBeNull()
    expect((await s.getRecord('keep'))?.revision).toBe(1)
    await s.close()
  })

  it('registers workspaces idempotently and redacts audit content', async () => {
    const s = new InMemoryMemoryStorage()
    await s.open()
    const ws = { id: 'w1', canonicalPath: '/repo/one' }
    await s.ensureWorkspace(ws)
    await s.ensureWorkspace(ws)
    expect(await collect(s.scanWorkspaces())).toEqual([ws])
    await s.commit({
      appendAudit: [{
        id: 'e1', recordId: 'r1', scope: 'global', workspaceId: null, operation: 'create',
        expectedRevision: null, committedRevision: 1, beforeContent: null, afterContent: 'secret',
        actor: 'host', committedAt: '2026-01-01T00:00:00.000Z',
      }],
    })
    await s.commit({ redactAuditForRecords: ['r1'] })
    const events = await collect(s.scanAudit({}))
    expect(events[0]!.afterContent).toBeNull()
    await s.close()
  })

  it('scanRecords filters by scope, workspaceId and statuses', async () => {
    const s = new InMemoryMemoryStorage()
    await s.open()
    await s.commit({
      insertRecords: [
        rec({ id: 'g', scope: 'global' }),
        rec({ id: 'w', scope: 'workspace', workspaceId: 'ws1' }),
        rec({ id: 'old', status: 'archived' }),
      ],
    })
    expect((await collect(s.scanRecords({ workspaceId: 'ws1' }))).map((r) => r.id)).toEqual(['w'])
    expect((await collect(s.scanRecords({ statuses: ['active', 'archived'] })))).toHaveLength(3)
    expect((await collect(s.scanRecords({ statuses: ['active'] }))).map((r) => r.id).sort()).toEqual(['g', 'w'])
    await s.close()
  })
})
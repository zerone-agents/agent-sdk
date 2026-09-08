import { describe, expect, it } from 'vitest'
import { createMemoryService } from './service.js'
import { InMemoryMemoryStorage } from './in-memory-storage.js'
import { MemoryValidationError } from './errors.js'
import type { MemoryService } from './types.js'

async function running(budgets = {}): Promise<MemoryService> {
  let idSeq = 0
  const service = createMemoryService({
    storage: new InMemoryMemoryStorage(),
    budgets,
    // Deterministic clock + sequential ids (existing test seams): the
    // ordering-sensitive assertions below (retention pruning, queryAudit
    // order) must not race the real millisecond clock or random-UUID
    // tie-breaks — see task-9-report.md concern 1 for the evidence.
    now: () => new Date(1_700_000_000_000),
    newId: () => `id-${String(idSeq++).padStart(3, '0')}`,
  })
  await service.start()
  return service
}

describe('capacity archival', () => {
  it('archives lowest-importance/oldest records atomically when the budget overflows', async () => {
    const service = await running({ globalChars: 10 })
    const s = await service.bind({ actor: 'session' })
    await s.add({ scope: 'global', content: 'aaaa', importance: 75 })   // 4
    await s.add({ scope: 'global', content: 'bb', importance: 25 })     // 2 → total 6
    const result = await s.add({ scope: 'global', content: 'ccccc', importance: 50 }) // +5 = 11 > 10
    // 'bb' (importance 25) is archived; 'aaaa'(75) and 'ccccc'(50) stay active: 4+5=9 <= 10
    expect(result.archived).toHaveLength(1)
    expect(result.archived[0]).toMatchObject({ content: 'bb', status: 'archived' })
    // one commit: primary create + archive + BOTH audit events
    expect(result.audit.map((e) => e.operation).sort()).toEqual(['archive', 'create'])
    expect(result.audit.find((e) => e.operation === 'archive')!.reason).toBe('capacity')
    const actives = await service.admin.queryRecords({ scope: 'global', status: 'active' })
    expect(actives.map((r) => r.content).sort()).toEqual(['aaaa', 'ccccc'])
    await service.stop()
  })

  it('workspace budget applies per workspace ID', async () => {
    const service = await running({ workspaceChars: 4 })
    const a = await service.bind({ actor: 'session', workspace: '/repo/a' })
    const b = await service.bind({ actor: 'session', workspace: '/repo/b' })
    await a.add({ scope: 'workspace', content: 'xxxx', importance: 50 })
    await expect(b.add({ scope: 'workspace', content: 'yyyy', importance: 50 })).resolves.toBeDefined()
    await service.stop()
  })

  it('capacity counts WEIGHTED chars: CJK content weighs 2 per code point (P2-5)', async () => {
    const service = await running({ globalChars: 5 })
    const s = await service.bind({ actor: 'session' })
    await s.add({ scope: 'global', content: '汉字', importance: 50 }) // 4 weighted
    const fit = await s.add({ scope: 'global', content: 'e', importance: 25 }) // 5 <= 5
    expect(fit.archived).toHaveLength(0)
    const overflow = await s.add({ scope: 'global', content: 'f', importance: 75 }) // 6 > 5
    expect(overflow.archived.map((r) => r.content)).toEqual(['e'])
    await service.stop()
  })

  it('restore may archive other records to satisfy the budget', async () => {
    const service = await running({ globalChars: 6 })
    const s = await service.bind({ actor: 'session' })
    const r1 = (await s.add({ scope: 'global', content: 'aaa', importance: 50 })).record!
    await s.add({ scope: 'global', content: 'bbb', importance: 25 })
    await service.admin.mutate({ type: 'archive', recordId: r1.id, expectedRevision: 1 }, { actor: 'host' })
    await s.add({ scope: 'global', content: 'ccc', importance: 75 }) // bbb(25)+ccc(75)=6
    const restored = await service.admin.mutate(
      { type: 'restore', recordId: r1.id, expectedRevision: 2 }, { actor: 'host' })
    // restore aaa(50): total 3+2+3=8 > 6 → archive bbb (lowest importance)
    expect(restored.record!.status).toBe('active')
    expect(restored.archived.map((r) => r.content)).toEqual(['bbb'])
    await service.stop()
  })

  it('restore REJECTS a record exceeding the CURRENT budget after a smaller-budget restart (§18-L)', async () => {
    // Budgets are per-instance configuration: a record archived under a large
    // budget may exceed a smaller one on restart. Same storage, two services.
    const storage = new InMemoryMemoryStorage()
    let idSeq = 0
    const newId = () => `id-${String(idSeq++).padStart(3, '0')}`
    const now = () => new Date(1_700_000_000_000)

    const first = createMemoryService({ storage, budgets: { globalChars: 10 }, now, newId })
    await first.start()
    const s = await first.bind({ actor: 'session' })
    const r1 = (await s.add({ scope: 'global', content: 'abcdefghij', importance: 50 })).record! // 10 <= 10
    await first.admin.mutate({ type: 'archive', recordId: r1.id, expectedRevision: 1 }, { actor: 'host' })
    await first.stop()

    const second = createMemoryService({ storage, budgets: { globalChars: 4 }, now, newId })
    await second.start()
    // content(10) > budget(4): the single-record over-budget rule covers restore
    // (§18-L) → rejected BEFORE commit, record stays archived (no silent >100% usage).
    await expect(
      second.admin.mutate({ type: 'restore', recordId: r1.id, expectedRevision: 2 }, { actor: 'host' }),
    ).rejects.toSatisfy(
      (e) => e instanceof MemoryValidationError && e.findings.some((f) => f.code === 'content.exceeds_budget'),
    )
    const actives = await second.admin.queryRecords({ scope: 'global', status: 'active' })
    expect(actives).toHaveLength(0) // nothing was committed
    await second.stop()
  })
})

describe('audit retention + purge redaction', () => {
  it('keeps only the newest N audit events, oldest pruned in the same commit', async () => {
    const service = await running({ auditRetention: 3 })
    const s = await service.bind({ actor: 'session' })
    for (let i = 0; i < 5; i++) {
      await s.add({ scope: 'global', content: `record-${i}`, importance: 50 })
    }
    const events = await service.admin.queryAudit({})
    expect(events).toHaveLength(3)
    expect(events.map((e) => e.afterContent)).toEqual(['record-4', 'record-3', 'record-2'])
    await service.stop()
  })

  it('purge erases content from records AND prior audit; final purge event has no content', async () => {
    const service = await running()
    const s = await service.bind({ actor: 'session' })
    const { record } = await s.add({ scope: 'global', content: 'erase me', importance: 50 })
    await s.remove(record!.id, 1)
    const purged = await service.admin.mutate(
      { type: 'purge', recordId: record!.id, expectedRevision: 2 }, { actor: 'host' })
    expect(purged.record).toBeNull()
    const events = await service.admin.queryAudit({ recordId: record!.id })
    expect(events.map((e) => e.operation)).toEqual(['purge', 'delete', 'create'])
    for (const e of events) {
      expect(e.beforeContent).toBeNull()
      expect(e.afterContent).toBeNull()
    }
    await service.stop()
  })

  it('queryAudit orders newest first and honors limit', async () => {
    const service = await running()
    const s = await service.bind({ actor: 'session' })
    await s.add({ scope: 'global', content: 'one', importance: 50 })
    await s.add({ scope: 'global', content: 'two', importance: 50 })
    const all = await service.admin.queryAudit({})
    expect(all.map((e) => e.afterContent)).toEqual(['two', 'one'])
    expect(await service.admin.queryAudit({ limit: 1 })).toHaveLength(1)
    await service.stop()
  })
})

describe('soft-delete audit keeps content (task-8 ledger close-out ①)', () => {
  it('session.remove and admin.delete keep record content in the delete audit event', async () => {
    const service = await running()
    const s = await service.bind({ actor: 'session' })
    // session path
    const { record } = await s.add({ scope: 'global', content: 'session soft', importance: 50 })
    await s.remove(record!.id, 1)
    let events = await service.admin.queryAudit({ recordId: record!.id })
    expect(events.find((e) => e.operation === 'delete')!.afterContent).toBe('session soft')
    // admin path (applyTransition carries content through)
    const { record: host } = await service.admin.mutate(
      { type: 'create', scope: 'global', content: 'host soft', importance: 50 }, { actor: 'host' })
    await service.admin.mutate({ type: 'delete', recordId: host!.id, expectedRevision: 1 }, { actor: 'host' })
    events = await service.admin.queryAudit({ recordId: host!.id })
    expect(events.find((e) => e.operation === 'delete')!.afterContent).toBe('host soft')
    await service.stop()
  })
})

describe('duplicate check excludes the record itself (task-8 ledger close-out ②)', () => {
  it("replace with the record's OWN content is not a duplicate", async () => {
    const service = await running()
    const s = await service.bind({ actor: 'session' })
    const { record } = await s.add({ scope: 'global', content: 'mine', importance: 50 })
    const updated = await s.replace(record!.id, 1, { content: 'mine' })
    expect(updated.record).toMatchObject({ content: 'mine', revision: 2 })
    await service.stop()
  })

  it("replace with ANOTHER record's content reports duplicate.content", async () => {
    const service = await running()
    const s = await service.bind({ actor: 'session' })
    await s.add({ scope: 'global', content: 'theirs', importance: 50 })
    const { record } = await s.add({ scope: 'global', content: 'mine', importance: 50 })
    await expect(s.replace(record!.id, 1, { content: 'theirs' }))
      .rejects.toSatisfy((e) => e instanceof MemoryValidationError && e.findings.some((f) => f.code === 'duplicate.content'))
    await service.stop()
  })
})
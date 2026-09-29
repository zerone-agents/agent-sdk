import { describe, expect, it } from 'vitest'
import { CommittedMessageIndex } from './index-map.js'
import { InMemorySessionStore } from './in-memory.js'
import { prepareOperation } from './prepare.js'
import type { NewRecord } from './types.js'
import type { NormalizedMessageParam } from '../providers/types.js'

const msg = (mid: string, text = 'x'): NormalizedMessageParam =>
  ({ id: mid, role: 'user', content: text }) as NormalizedMessageParam

const buildRecord = (m: NormalizedMessageParam): NewRecord => ({
  recordId: `rec-${(m as { id: string }).id}`,
  message: m,
  actor: { kind: 'main' },
})

describe('CommittedMessageIndex (issue #131)', () => {
  it('diff: all-new history → all newRecords', () => {
    const idx = new CommittedMessageIndex()
    const history = [msg('m1'), msg('m2')]
    const records = idx.diff(history, buildRecord)
    expect(records).toHaveLength(2)
    expect(records.map((r) => (r.message as { id: string }).id)).toEqual(['m1', 'm2'])
  })

  it('diff: some committed → only uncommitted returned', () => {
    const idx = new CommittedMessageIndex()
    idx.apply([buildRecord(msg('m1'))])
    const history = [msg('m1'), msg('m2')]
    const records = idx.diff(history, buildRecord)
    expect(records).toHaveLength(1)
    expect((records[0].message as { id: string }).id).toBe('m2')
  })

  it('diff: all committed → empty array', () => {
    const idx = new CommittedMessageIndex()
    idx.apply([buildRecord(msg('m1')), buildRecord(msg('m2'))])
    const history = [msg('m1'), msg('m2')]
    expect(idx.diff(history, buildRecord)).toHaveLength(0)
  })

  it('apply: updates the map for subsequent diffs', () => {
    const idx = new CommittedMessageIndex()
    const history = [msg('m1')]
    expect(idx.diff(history, buildRecord)).toHaveLength(1)
    idx.apply([buildRecord(msg('m1'))])
    expect(idx.diff(history, buildRecord)).toHaveLength(0)
  })

  it('rebuild: restores from branch.records (full log — includes summaries)', async () => {
    const store = new InMemorySessionStore()
    // Seed a checkpoint with a summary record
    const records: NewRecord[] = [
      { recordId: 'r1', message: { id: 'm1', role: 'user', content: 'a' }, actor: { kind: 'main' } },
      { recordId: 'r2', message: { id: 'm2', role: 'user', content: 'b' }, actor: { kind: 'main' } },
      { recordId: 'S1', message: { id: 'sum-1', role: 'assistant', content: 'summary' }, actor: { kind: 'sdk' }, kind: 'summary' },
    ]
    await store.commit('s1', prepareOperation('s1', {
      kind: 'checkpoint', expectedRevision: null,
      changeSet: { kind: 'checkpoint', branchId: 'b1', newRecords: records, metadataPatch: {} },
    }))
    const idx = await CommittedMessageIndex.rebuild(store, 's1', 'b1')
    // ALL records indexed — including the summary (m1, m2, sum-1)
    const history = [msg('m1'), msg('m2'), { id: 'sum-1', role: 'assistant', content: 'summary' } as NormalizedMessageParam]
    expect(idx.diff(history, buildRecord)).toHaveLength(0)  // nothing new — all indexed
  })

  it('compact后rebuild + diff: summary messages in context do NOT produce newRecords', async () => {
    const store = new InMemorySessionStore()
    // Simulate compact: records include summary + tail; context = [summary, tail]
    const originals: NewRecord[] = [
      { recordId: 'r1', message: { id: 'm1', role: 'user', content: 'one' }, actor: { kind: 'main' } },
      { recordId: 'r2', message: { id: 'm2', role: 'user', content: 'two' }, actor: { kind: 'main' } },
    ]
    const summaryRec: NewRecord = {
      recordId: 'S1',
      message: { id: 'sum-1', role: 'assistant', content: 'summary of 1-2' },
      actor: { kind: 'sdk' },
      kind: 'summary',
    }
    await store.commit('s1', prepareOperation('s1', {
      kind: 'compact', expectedRevision: null,
      changeSet: {
        kind: 'compact', branchId: 'b1',
        newRecords: [...originals, summaryRec],
        context: { segments: [
          { kind: 'summary', summaryRecordId: 'S1', covers: { branchId: 'b1', recordIds: ['r1', 'r2'] } },
        ] },
        summary: { summaryRecordId: 'S1', covers: { branchId: 'b1', recordIds: ['r1', 'r2'] } },
      },
    }))
    // Rebuild index from full records
    const idx = await CommittedMessageIndex.rebuild(store, 's1', 'b1')
    // Agent's history after resume = context messages (includes summary message)
    const historyAfterResume = await store.loadContext('s1', 'b1')
    // diff should find NO new records — summary message is already indexed
    expect(idx.diff(historyAfterResume, buildRecord)).toHaveLength(0)
  })

  it('compact → rebuild → new message → diff returns only the new one', async () => {
    const store = new InMemorySessionStore()
    // Compact commits originals + summary
    await store.commit('s1', prepareOperation('s1', {
      kind: 'compact', expectedRevision: null,
      changeSet: {
        kind: 'compact', branchId: 'b1',
        newRecords: [
          { recordId: 'r1', message: { id: 'm1', role: 'user', content: 'one' }, actor: { kind: 'main' } },
          { recordId: 'S1', message: { id: 'sum-1', role: 'assistant', content: 'sum' }, actor: { kind: 'sdk' }, kind: 'summary' },
        ],
        context: { segments: [{ kind: 'summary', summaryRecordId: 'S1', covers: { branchId: 'b1', recordIds: ['r1'] } }] },
        summary: { summaryRecordId: 'S1', covers: { branchId: 'b1', recordIds: ['r1'] } },
      },
    }))
    const idx = await CommittedMessageIndex.rebuild(store, 's1', 'b1')
    // New message arrives after compact
    const history = [
      { id: 'sum-1', role: 'assistant', content: 'sum' } as NormalizedMessageParam,  // already committed
      { id: 'm-new', role: 'user', content: 'fresh' } as NormalizedMessageParam,      // NEW
    ]
    const records = idx.diff(history, buildRecord)
    expect(records).toHaveLength(1)
    expect((records[0].message as { id: string }).id).toBe('m-new')
  })
})
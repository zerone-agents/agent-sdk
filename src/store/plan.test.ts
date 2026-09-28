import { describe, expect, it } from 'vitest'
import { planCompact } from './plan.js'
import type { ChangeSet, NewRecord } from './types.js'

type CompactChangeSet = Extract<ChangeSet, { kind: 'compact' }>

const rec = (recordId: string, messageId: string, text = 'x'): NewRecord =>
  ({ recordId, message: { id: messageId, role: 'user', content: text }, actor: { kind: 'main' } })
const sum = (recordId: string): NewRecord =>
  ({ recordId, message: { id: `${recordId}-msg`, role: 'assistant', content: 'summary text' }, actor: { kind: 'sdk' }, kind: 'summary' })

describe('planCompact (issue #131, spec §4.2)', () => {
  it('assembles single-commit changeSet: pending originals + summary + [summary,kept] context', () => {
    const cs = planCompact({
      branchId: 'b1',
      coveredSegments: [
        { kind: 'records', recordIds: ['r1', 'r2'] },
        { kind: 'records', recordIds: ['r4p'] },          // r4p is a pending (unpersisted) original
      ],
      pendingRecords: [rec('r4p', 'm4', 'pending original')],
      summaryRecord: sum('S1'),
      keptSegment: { kind: 'records', recordIds: ['r5'] },
    }) as CompactChangeSet
    expect(cs.kind).toBe('compact')
    expect(cs.newRecords.map((r) => r.recordId)).toEqual(['r4p', 'S1'])
    expect(cs.summary).toEqual({ summaryRecordId: 'S1', covers: { branchId: 'b1', recordIds: ['r1', 'r2', 'r4p'] } })
    expect(cs.context.segments.map((s) => s.kind)).toEqual(['summary', 'records'])
    expect((cs.context.segments[1] as { recordIds: string[] }).recordIds).toEqual(['r5'])
  })

  it('second-round compact stays message-only (old summary expanded away, no nesting)', () => {
    const cs = planCompact({
      branchId: 'b1',
      coveredSegments: [
        { kind: 'summary', summaryRecordId: 'S1', covers: { branchId: 'b1', recordIds: ['r1', 'r2'] } },
        { kind: 'records', recordIds: ['r3'] },
      ],
      pendingRecords: [],
      summaryRecord: sum('S2'),
      keptSegment: { kind: 'records', recordIds: [] },
    }) as CompactChangeSet
    expect(cs.summary.covers).toEqual({ branchId: 'b1', recordIds: ['r1', 'r2', 'r3'] })   // no S1, single layer
  })
})
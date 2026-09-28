import { describe, expect, it } from 'vitest'
import { rebuildRollback } from './algorithm.js'
import { RollbackTargetInvalidError } from './errors.js'
import type { Branch, ContextRef, MessageRecord, SessionOwnership, SessionState } from './types.js'

// 布局 helper：[recordId, messageId, kind, content] → records Map + branch
type Entry = [recordId: string, messageId: string, kind?: 'message' | 'summary', content?: unknown]

function recordsOf(entries: Entry[]): Map<string, MessageRecord> {
  const m = new Map<string, MessageRecord>()
  for (const [rid, mid, kind = 'message', content] of entries) {
    m.set(rid, {
      recordId: rid,
      messageId: mid,
      message: { id: mid, role: 'user', content: content ?? 'text' } as never,
      actor: { kind: 'main' },
      createdAt: '2026-09-24T00:00:00.000Z',
      kind,
    })
  }
  return m
}

function branchOf(logs: string[], effective: string[], context: ContextRef): Branch {
  return { branchId: 'b1', records: logs, effective, context, createdAt: '2026-09-24T00:00:00.000Z' }
}

const recsSeg = (...recordIds: string[]): ContextRef => ({ segments: [{ kind: 'records', recordIds }] })
const sumSeg = (summaryRecordId: string, covers: string[]): ContextRef =>
  ({ segments: [{ kind: 'summary', summaryRecordId, covers: { branchId: 'b1', recordIds: covers } }] })

describe('rebuildRollback (issue #131, spec §4.3 five-step rebuild)', () => {
  it('A/B/C rollback-to-B: context has NO C content and NO C-covering summary (App freeze case)', () => {
    const records = recordsOf([['A1', 'mA'], ['B1', 'mB'], ['C1', 'mC'], ['S1', 'sum-1', 'summary']])
    const branch = branchOf(['A1', 'B1', 'C1', 'S1'], ['A1', 'B1', 'C1'], sumSeg('S1', ['A1', 'B1', 'C1']))
    const plan = rebuildRollback('s1', branch, records, 'mB')
    expect(plan.logs).toEqual(['A1', 'B1'])
    expect(plan.effective).toEqual(['A1', 'B1'])
    // model context: no C original, no summary covering C — records segment only
    expect(plan.context).toEqual(recsSeg('A1', 'B1'))
  })

  it('revise-version rollback uses only the version valid at the target point', () => {
    const records = recordsOf([['A1', 'mA'], ['B1', 'mB'], ['A2', 'mA']])
    const branch = branchOf(['A1', 'B1', 'A2'], ['A2', 'B1'], recsSeg('A2', 'B1'))
    const plan = rebuildRollback('s1', branch, records, 'mB')
    expect(plan.logs).toEqual(['A1', 'B1'])
    expect(plan.effective).toEqual(['A1', 'B1'])   // A resolves to A1 (not the future A2)
    expect(plan.context).toEqual(recsSeg('A1', 'B1'))
  })

  it('summary reuse passes when covers versions == new effective versions', () => {
    const records = recordsOf([['A1', 'mA'], ['B1', 'mB'], ['S1', 'sum-1', 'summary']])
    const branch = branchOf(['A1', 'B1', 'S1'], ['A1', 'B1'], sumSeg('S1', ['A1', 'B1']))
    const plan = rebuildRollback('s1', branch, records, 'mB')
    expect(plan.effective).toEqual(['A1', 'B1'])
    expect(plan.context).toEqual(sumSeg('S1', ['A1', 'B1']))   // summary stays (versions match)
  })

  it('target splitting tool_use/tool_result pair throws RollbackTargetInvalidError', () => {
    const toolUse = [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }]
    const toolResult = [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]
    const records = recordsOf([
      ['U1', 'mU', 'message', toolUse],
      ['TR1', 'mTR', 'message', toolResult],
      ['U2', 'mU2'],
    ])
    const branch = branchOf(['U1', 'TR1', 'U2'], ['U1', 'TR1', 'U2'], recsSeg('U1', 'TR1', 'U2'))
    // rollback to mU keeps the tool_use without its result — must be rejected
    expect(() => rebuildRollback('s1', branch, records, 'mU')).toThrow(RollbackTargetInvalidError)
    // rollback to mTR keeps the pair complete — succeeds
    const plan = rebuildRollback('s1', branch, records, 'mTR')
    expect(plan.effective).toEqual(['U1', 'TR1'])
  })

  it('unknown target messageId throws', () => {
    const records = recordsOf([['A1', 'mA']])
    const branch = branchOf(['A1'], ['A1'], recsSeg('A1'))
    expect(() => rebuildRollback('s1', branch, records, 'mGhost')).toThrow(RollbackTargetInvalidError)
  })
})

describe('rollback / branch-switch apply paths (issue #131)', () => {
  // 集成：经 InMemorySessionStore 全链路（plan→prepare→commit）
  it('rollback commit creates a new branch, old branch untouched; branch-switch restores it', async () => {
    const { InMemorySessionStore } = await import('./in-memory.js')
    const { prepareOperation } = await import('./prepare.js')
    const store = new InMemorySessionStore()
    // seed: m1, m2 on b1
    const seed = {
      kind: 'checkpoint' as const, expectedRevision: null,
      changeSet: {
        kind: 'checkpoint' as const, branchId: 'b1',
        newRecords: [
          { recordId: 'r1', message: { id: 'm1', role: 'user' as const, content: 'one' }, actor: { kind: 'main' as const } },
          { recordId: 'r2', message: { id: 'm2', role: 'user' as const, content: 'two' }, actor: { kind: 'main' as const } },
        ],
        metadataPatch: { model: 'm' },
      },
    }
    await store.commit('s1', prepareOperation('s1', seed as never))
    const state = await store.loadSession('s1')
    expect(state!.currentBranchId).toBe('b1')

    // rollback to m1: new branch with effective [r1]
    const rb = {
      kind: 'rollback' as const, expectedRevision: 1 as const,
      changeSet: {
        kind: 'rollback' as const, fromBranchId: 'b1', atMessageId: 'm1', newBranchId: 'b2',
        records: ['r1'], effective: ['r1'],
        context: { segments: [{ kind: 'records' as const, recordIds: ['r1'] }] },
      },
    }
    const r2 = await store.commit('s1', prepareOperation('s1', rb as never))
    expect(r2.revision).toBe(2)
    const after = await store.loadSession('s1')
    expect(after!.currentBranchId).toBe('b2')
    expect((await store.loadHistory('s1', 'b1')).records.map((x) => x.recordId)).toEqual(['r1', 'r2'])   // old branch untouched

    // branch-switch back to b1 (commit + CAS + receipt)
    const sw = {
      kind: 'branch-switch' as const, expectedRevision: 2 as const,
      changeSet: { kind: 'branch-switch' as const, toBranchId: 'b1' },
    }
    await store.commit('s1', prepareOperation('s1', sw as never))
    const restored = await store.loadSession('s1')
    expect(restored!.currentBranchId).toBe('b1')
    expect((await store.loadContext('s1', 'b1')).map((m) => m.id)).toEqual(['m1', 'm2'])
  })

  it('planRollback reads the store, computes the five-step plan and commits end-to-end', async () => {
    const { InMemorySessionStore } = await import('./in-memory.js')
    const { prepareOperation } = await import('./prepare.js')
    const { planRollback } = await import('./plan.js')
    const store = new InMemorySessionStore()
    const seedMsgs = ['one', 'two', 'three'].map((t, i) => ({
      recordId: `r${i + 1}`,
      message: { id: `m${i + 1}`, role: 'user' as const, content: t },
      actor: { kind: 'main' as const },
    }))
    await store.commit('s1', prepareOperation('s1', {
      kind: 'checkpoint', expectedRevision: null,
      changeSet: { kind: 'checkpoint', branchId: 'b1', newRecords: seedMsgs, metadataPatch: { model: 'm' } },
    } as never))
    const intent = await planRollback(store, 's1', 'b1', 'm1')
    expect(intent.kind).toBe('rollback')
    expect(intent.expectedRevision).toBe(1)
    const r = await store.commit('s1', prepareOperation('s1', intent as never))
    expect(r.revision).toBe(2)
    const state = await store.loadSession('s1')
    expect(state!.currentBranchId).not.toBe('b1')
    expect((await store.loadContext('s1', state!.currentBranchId)).map((m) => m.id)).toEqual(['m1'])
  })
})
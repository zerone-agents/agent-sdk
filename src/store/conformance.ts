/**
 * runSessionStoreConformance —— SessionStore v4 契约一致性套件（issue #131）。
 *
 * **App 复用入口**：对任意 SessionStore 实现（如 SQLite adapter）运行 P1 行为组，
 * 验证与 SDK 契约（SPEC v1.4）一致。不依赖 vitest（node:assert）。
 *
 * §10 验收覆盖分界（诚实标注，不虚报）：
 * - p1（本套件）：#1 读取契约 / #2 compact 原文原子 / #3 rollback·fork·revise（含
 *   无未来泄漏断言）/ #8 tombstone / #9 append·revise / #10 todos / #11 register 三场景 /
 *   #12 import 基础（initialRevision）/ #5 的基础回执查询
 * - p2（后续追加）：#4–#7 凭据去重·重试状态机·fencing 校验·保留窗口（完整恢复协议）
 * - p3（后续追加）：#12 导入三态完整协议、编排接入、FileStore
 *
 * NB：recordId 全局唯一（spec §2.1）——套件在**单个 store** 上运行全部场景，
 * helper 必须生成唯一 recordId（实现的全局唯一校验会拦截复用）。
 */
import assert from 'node:assert/strict'
import { prepareOperation } from './prepare.js'
import type { SessionStore } from './session-store.js'
import type { NewRecord, OperationIntent } from './types.js'

export interface ConformanceOptions {
  phases?: Array<'p1'>
}

export async function runSessionStoreConformance(store: SessionStore, opts: ConformanceOptions = {}): Promise<void> {
  const phases = new Set(opts.phases ?? ['p1'])
  if (phases.has('p1')) await p1Suite(store)
}

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch (err) {
    throw new Error(`[conformance p1] ${name}: ${(err as Error).message}`)
  }
}

// ── 构造 helper（仅契约类型 + prepareOperation；recordId 套件内全局唯一） ──

let recCounter = 0
const rec = (messageId: string, text = 'x'): NewRecord => ({
  recordId: `c-${++recCounter}`,
  message: { id: messageId, role: 'user', content: text },
  actor: { kind: 'main' },
})
const sum = (): NewRecord => ({
  recordId: `c-${++recCounter}`,
  message: { id: `sum-${recCounter}`, role: 'assistant', content: 'summary' },
  actor: { kind: 'sdk' },
  kind: 'summary',
})

async function checkpoint(store: SessionStore, sessionId: string, rev: number | null, records: NewRecord[]): Promise<void> {
  const intent: OperationIntent = {
    kind: 'checkpoint', expectedRevision: rev,
    changeSet: { kind: 'checkpoint', branchId: 'b1', newRecords: records, metadataPatch: { model: 'm' } },
  }
  await store.commit(sessionId, prepareOperation(sessionId, intent))
}

async function p1Suite(store: SessionStore): Promise<void> {
  let counter = 0
  const sid = () => `conf-${++counter}`

  await step('checkpoint: prepare→commit, revision, CAS both directions', async () => {
    const s = sid()
    const r = await checkpointReturning(store, s, null, [rec('m1')])
    assert.equal(r.revision, 1)
    await assert.rejects(() => store.commit(s, prepareOperation(s, {
      kind: 'checkpoint', expectedRevision: null,
      changeSet: { kind: 'checkpoint', branchId: 'b1', newRecords: [rec('m2')], metadataPatch: {} },
    })), /conflict/i)
    await assert.rejects(() => store.commit(s, prepareOperation(s, {
      kind: 'checkpoint', expectedRevision: 9,
      changeSet: { kind: 'checkpoint', branchId: 'b1', newRecords: [rec('m3')], metadataPatch: {} },
    })), /conflict/i)
    assert.equal((await store.loadHistory(s, 'b1')).records.length, 1)
  })

  await step('compact: originals+summary in ONE create-only commit; effective/context split', async () => {
    const s = sid()
    const a = rec('mA', 'first')
    const b = rec('mB', 'second')
    const sv = sum()
    const covers = { branchId: 'b1', recordIds: [a.recordId, b.recordId] }
    const r = await store.commit(s, prepareOperation(s, {
      kind: 'compact', expectedRevision: null,
      changeSet: {
        kind: 'compact', branchId: 'b1', newRecords: [a, b, sv],
        context: { segments: [{ kind: 'summary', summaryRecordId: sv.recordId, covers }, { kind: 'records', recordIds: [] }] },
        summary: { summaryRecordId: sv.recordId, covers },
      },
    }))
    assert.equal(r.revision, 1)
    const audit = await store.loadHistory(s, 'b1', { includeSuperseded: true })
    assert.deepEqual(audit.records.map((x) => x.recordId), [a.recordId, b.recordId, sv.recordId])   // same transaction
    assert.deepEqual((await store.loadHistory(s, 'b1')).records.map((x) => x.recordId), [a.recordId, b.recordId])   // effective: no summary
    assert.equal((await store.loadContext(s, 'b1')).length, 1)   // model context compacted
  })

  await step('rollback: A/B/C — no C original, no C-covering summary in model context', async () => {
    const s = sid()
    const A = rec('mA', 'A')
    const B = rec('mB', 'B')
    const C = rec('mC', 'C')
    const S = sum()
    const covers = { branchId: 'b1', recordIds: [A.recordId, B.recordId, C.recordId] }
    await store.commit(s, prepareOperation(s, {
      kind: 'checkpoint', expectedRevision: null,
      changeSet: {
        kind: 'checkpoint', branchId: 'b1', newRecords: [A, B, C, S],
        context: { segments: [{ kind: 'summary', summaryRecordId: S.recordId, covers }] },
        metadataPatch: {},
      },
    }))
    await store.commit(s, prepareOperation(s, {
      kind: 'rollback', expectedRevision: 1,
      changeSet: {
        kind: 'rollback', fromBranchId: 'b1', atMessageId: 'mB', newBranchId: 'b2',
        records: [A.recordId, B.recordId], effective: [A.recordId, B.recordId],
        context: { segments: [{ kind: 'records', recordIds: [A.recordId, B.recordId] }] },
      },
    }))
    assert.equal((await store.loadSession(s))!.currentBranchId, 'b2')
    const ctx = await store.loadContext(s, 'b2')
    assert.equal(ctx.length, 2)
    assert.ok(!ctx.some((m) => m.id === 'mC'), 'model context must not contain C')
    assert.ok(!ctx.some((m) => m.id === S.message.id), 'model context must not contain the C-covering summary')
  })

  await step('branch: old branch retained; branch-switch restores (commit+CAS)', async () => {
    const s = sid()
    const one = rec('m1', 'one')
    const two = rec('m2', 'two')
    await checkpoint(store, s, null, [one, two])
    await store.commit(s, prepareOperation(s, {
      kind: 'rollback', expectedRevision: 1,
      changeSet: {
        kind: 'rollback', fromBranchId: 'b1', atMessageId: 'm1', newBranchId: 'b2',
        records: [one.recordId], effective: [one.recordId],
        context: { segments: [{ kind: 'records', recordIds: [one.recordId] }] },
      },
    }))
    assert.deepEqual((await store.loadHistory(s, 'b1')).records.map((x) => x.recordId), [one.recordId, two.recordId])   // untouched
    await store.commit(s, prepareOperation(s, {
      kind: 'branch-switch', expectedRevision: 2,
      changeSet: { kind: 'branch-switch', toBranchId: 'b1' },
    }))
    assert.equal((await store.loadSession(s))!.currentBranchId, 'b1')
  })

  await step('append/revise: contextAppend flag; in-place swap; audit dual versions', async () => {
    const s = sid()
    const v1 = rec('m1', 'v1')
    const extra = rec('m2', 'side')
    await checkpoint(store, s, null, [v1])
    await store.commit(s, prepareOperation(s, {
      kind: 'append', expectedRevision: 1,
      changeSet: { kind: 'append', branchId: 'b1', newRecords: [extra], contextAppend: false },
    }))
    assert.deepEqual((await store.loadContext(s, 'b1')).map((m) => m.id), ['m1'])   // body only
    const v2 = rec('m1', 'v2')
    await store.commit(s, prepareOperation(s, {
      kind: 'revise', expectedRevision: 2,
      changeSet: {
        kind: 'revise', branchId: 'b1', messageId: 'm1', newRecord: v2,
        contextUpdate: { segments: [{ kind: 'records', recordIds: [v2.recordId] }] },
      },
    }))
    assert.deepEqual((await store.loadHistory(s, 'b1')).records.map((x) => x.recordId), [v2.recordId, extra.recordId])
    const audit = await store.loadHistory(s, 'b1', { includeSuperseded: true })
    assert.deepEqual(audit.records.map((x) => x.recordId), [v1.recordId, extra.recordId, v2.recordId])
  })

  await step('fork: sourceRevision freeze check (source advanced after prepare → reject)', async () => {
    const src = sid()
    const dst = `conf-${counter}-fork`
    const one = rec('m1', 'one')
    await checkpoint(store, src, null, [one])
    const intent: OperationIntent = {
      kind: 'fork', expectedRevision: null,
      changeSet: {
        kind: 'fork', newSessionId: dst, source: { sessionId: src, branchId: 'b1' }, sourceRevision: 1,
        records: [one.recordId], effective: [one.recordId],
        context: { segments: [{ kind: 'records', recordIds: [one.recordId] }] },
        metadata: {}, ownership: { rootSessionId: dst },
      },
    }
    // source advances AFTER prepare → commit must reject (not audit-only)
    await store.commit(src, prepareOperation(src, {
      kind: 'append', expectedRevision: 1,
      changeSet: { kind: 'append', branchId: 'b1', newRecords: [rec('m2')], contextAppend: true },
    }))
    await assert.rejects(() => store.commit(dst, prepareOperation(dst, intent)), /conflict/i)
  })

  await step('delete: tombstone, cascadeOwned incl. todo-only, late write rejected', async () => {
    const root = sid()
    const sub = `conf-${counter}-sub`
    await store.commit(root, prepareOperation(root, { kind: 'register', ownership: { rootSessionId: root } }))
    await store.saveTodos(sub, prepareOperation(sub, {
      kind: 'save-todos', todos: [], ownership: { rootSessionId: root, parentSessionId: root },
    }))
    const r = await store.deleteSession(root, prepareOperation(root, { kind: 'delete', cascadeOwned: true }))
    assert.equal((r.value as { deleted: boolean }).deleted, true)
    assert.equal(await store.loadSession(root), null)
    assert.equal(await store.loadSession(sub), null)   // cascaded (incl. todo-only)
    await assert.rejects(() => store.commit(root, prepareOperation(root, {
      kind: 'append', expectedRevision: 1,
      changeSet: { kind: 'append', branchId: 'b1', newRecords: [rec('m9')], contextAppend: true },
    })), /not authorized|deleted/i)
  })

  await step('register: three scenarios (self idempotent / swap rejected / unregistered root rejected)', async () => {
    const root = sid()
    const r1 = await store.commit(root, prepareOperation(root, { kind: 'register', ownership: { rootSessionId: root } }))
    assert.equal((r1 as { revision?: number }).revision, undefined)   // no revision
    await store.commit(root, prepareOperation(root, { kind: 'register', ownership: { rootSessionId: root } }))   // idempotent
    await assert.rejects(() => store.commit(root, prepareOperation(root, {
      kind: 'register', ownership: { rootSessionId: 'other' },
    })), /ownership/i)
    // unregistered root → child first write rejected, no residual row
    const orphan = `conf-${counter}-orphan`
    await assert.rejects(() => store.saveTodos(orphan, prepareOperation(orphan, {
      kind: 'save-todos', todos: [], ownership: { rootSessionId: 'never-registered' },
    })), /not authorized|registered/i)
    assert.equal(await store.loadSession(orphan), null)
  })

  await step('todos: no transcript revision; todo-only first write after registration', async () => {
    const root = sid()
    const sub = `conf-${counter}-sub`
    await store.commit(root, prepareOperation(root, { kind: 'register', ownership: { rootSessionId: root } }))
    await checkpoint(store, root, null, [rec('m1')])
    const before = (await store.loadSession(root))!.revision
    const tr = await store.saveTodos(root, prepareOperation(root, {
      kind: 'save-todos', todos: [{ content: 'x', status: 'pending', priority: 'high' }],
    }))
    assert.equal((tr as { revision?: number }).revision, undefined)
    assert.equal((await store.loadSession(root))!.revision, before)   // unchanged
    await store.saveTodos(sub, prepareOperation(sub, {
      kind: 'save-todos', todos: [], ownership: { rootSessionId: root, parentSessionId: root },
    }))
    const subState = await store.loadSession(sub)
    assert.ok(subState)
    assert.equal(subState!.revision, 0)   // todo-only: does not block first transcript create-only
  })

  await step('import: create-only + initialRevision exception', async () => {
    const s = sid()
    const legacy = rec('m1', 'legacy')
    const r = await store.commit(s, prepareOperation(s, {
      kind: 'import', expectedRevision: null,
      changeSet: {
        kind: 'import', branchId: 'b1', newRecords: [legacy],
        effective: [legacy.recordId], context: { segments: [{ kind: 'records', recordIds: [legacy.recordId] }] },
        metadata: {}, ownership: { rootSessionId: s }, initialRevision: 7,
      },
    }))
    assert.equal(r.revision, 7)
    const r2 = await store.commit(s, prepareOperation(s, {
      kind: 'append', expectedRevision: 7,
      changeSet: { kind: 'append', branchId: 'b1', newRecords: [rec('m2')], contextAppend: true },
    }))
    assert.equal(r2.revision, 8)   // increments from the imported value
  })

  await step('queryOperation: basic receipt round-trip (full recovery protocol is p2)', async () => {
    const s = sid()
    const r = await checkpointReturning(store, s, null, [rec('m1')])
    const q = await store.queryOperation(s, r.operationId)
    assert.equal(q.status, 'committed')
    if (q.status === 'committed') assert.equal(q.receipt.revision, 1)
    assert.equal((await store.queryOperation(s, 'nope')).status, 'not-committed')
  })
}

async function checkpointReturning(
  store: SessionStore, sessionId: string, rev: number | null, records: NewRecord[],
): Promise<{ revision?: number; operationId: string }> {
  const intent: OperationIntent = {
    kind: 'checkpoint', expectedRevision: rev,
    changeSet: { kind: 'checkpoint', branchId: 'b1', newRecords: records, metadataPatch: {} },
  }
  const r = await store.commit(sessionId, prepareOperation(sessionId, intent))
  return { revision: r.revision, operationId: r.operationId }
}
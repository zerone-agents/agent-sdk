/**
 * runSessionStoreConformance —— SessionStore v4 契约一致性套件（issue #131）。
 *
 * **App 复用入口**：对任意 SessionStore 实现（如 SQLite adapter）运行行为组，
 * 验证与 SDK 契约（SPEC v1.4）一致。不依赖 vitest（node:assert）。
 *
 * **重要：phases 分別测试**——`phases: ['p1']` 只运行 P1 组，`phases: ['p2']` 只运行
 * P2 组，二者**不等于「完整 P1+P2 合规」**。App 需分别完成两阶段测试：
 *   1. P1：对无 fencing 的实例运行 `phases: ['p1']`（基础操作合规）
 *   2. P2：对有 fencing + retention 的实例运行 `phases: ['p2']` + `p2Context`
 * P1 不携带 auth；在有 fencing 的实例上直接运行 P1 会因缺少授权而失败——
 * 这是设计行为（P1 验证无 fencing 的基础合规）。
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
import { planRollback } from './plan.js'
import { fingerprintOperation } from './fingerprint.js'
import type { SessionStore } from './session-store.js'
import type { AuthorizationContext, NewRecord, OperationIntent, PreparedOperation } from './types.js'
import { InMemorySessionStore } from './in-memory.js'

/** P2 conformance 需要的测试能力——请求 phases:['p2'] 时必须提供（不可跳过）。 */
export interface P2TestContext {
  store: SessionStore
  /** 当前有效授权 */
  auth: AuthorizationContext
  /** 模拟租约过期（无人接管）——此后全部写入被拒直到 rotateAuth */
  expireAuth(): void
  /** 新执行者接管——此后旧 auth 必须被拒绝 */
  rotateAuth(newAuth: AuthorizationContext): void
  /** 推进回收水位到当前上界 */
  advanceWatermark(): void
  /** 等待保留窗口超龄 */
  elapseRetention(): Promise<void>
  /** 当前提交上界 */
  getCommitUpperBound(): number
}

export interface ConformanceOptions {
  phases?: Array<'p1' | 'p2'>
  /** phases 含 'p2' 时必需——缺失则抛错（不可静默跳过核心检查） */
  p2Context?: P2TestContext
}

export async function runSessionStoreConformance(store: SessionStore, opts: ConformanceOptions = {}): Promise<void> {
  const phases = new Set(opts.phases ?? ['p1'])
  if (phases.has('p1')) await p1Suite(store)
  if (phases.has('p2')) {
    if (!opts.p2Context) {
      throw new Error('P2 conformance requires p2Context (fencing/retention capabilities) — cannot skip core checks')
    }
    // 评审 P1：ctx.store 必须与被测 store 是同一实例——防止「传入 A、测了 B」的假通过
    if (opts.p2Context.store !== store) {
      throw new Error(
        'P2 conformance: p2Context.store must be the SAME instance as the store parameter — ' +
        'cannot claim compliance for a different implementation',
      )
    }
    await p2Suite(opts.p2Context)
  }
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

  // ── 评审反例组（PR #132 复审；跨 adapter 契约——修复后钉死） ──

  await step('failed commit: zero residue (no partial records, no revision, record reusable)', async () => {
    const s = sid()
    const r1 = rec('m1', 'v1')
    await checkpoint(store, s, null, [r1])
    const dup = { ...rec('m1-bis', 'v1-bis'), recordId: r1.recordId }   // duplicate recordId mid-batch
    const r2 = rec('m2', 'v2')
    await assert.rejects(() => store.commit(s, prepareOperation(s, {
      kind: 'append', expectedRevision: 1,
      changeSet: { kind: 'append', branchId: 'b1', newRecords: [r2, dup], contextAppend: true },
    })), /duplicate/i)
    assert.equal((await store.loadSession(s))!.revision, 1)             // unchanged
    assert.deepEqual(await store.loadRecords(s, [r2.recordId]), [null]) // no residue
    // same recordId remains usable for a later valid commit
    await store.commit(s, prepareOperation(s, {
      kind: 'append', expectedRevision: 1,
      changeSet: { kind: 'append', branchId: 'b1', newRecords: [r2], contextAppend: true },
    }))
    assert.equal((await store.loadSession(s))!.revision, 2)
  })

  await step('concurrent create-only forks on one target: exactly one succeeds', async () => {
    const src = sid()
    const one = rec('m1')
    await checkpoint(store, src, null, [one])
    const dst = `conf-${counter}-race`
    const mkIntent = (): OperationIntent => ({
      kind: 'fork', expectedRevision: null,
      changeSet: {
        kind: 'fork', newSessionId: dst, source: { sessionId: src, branchId: 'b1' }, sourceRevision: 1,
        records: [one.recordId], effective: [one.recordId],
        context: { segments: [{ kind: 'records', recordIds: [one.recordId] }] },
        metadata: {}, ownership: { rootSessionId: dst },
      },
    })
    const results = await Promise.allSettled([
      store.commit(dst, prepareOperation(dst, mkIntent())),
      store.commit(dst, prepareOperation(dst, mkIntent())),
    ])
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, 'exactly one winner')
  })

  await step('rollback never widens the original model-context boundary (UI-only body stays out)', async () => {
    const s = sid()
    const A = rec('mA', 'A')
    await checkpoint(store, s, null, [A])                                  // context [A]
    const B = rec('mB', 'B')
    await store.commit(s, prepareOperation(s, {
      kind: 'append', expectedRevision: 1,
      changeSet: { kind: 'append', branchId: 'b1', newRecords: [B], contextAppend: false },   // UI-only
    }))
    const C = rec('mC', 'C')
    await store.commit(s, prepareOperation(s, {
      kind: 'append', expectedRevision: 2,
      changeSet: { kind: 'append', branchId: 'b1', newRecords: [C], contextAppend: true },    // context [A, C]
    }))
    const intent = await planRollback(store, s, 'b1', 'mC')                // 走 SDK 五步重建
    await store.commit(s, prepareOperation(s, intent as never))
    const state = await store.loadSession(s)
    const ctx = await store.loadContext(s, state!.currentBranchId)
    assert.deepEqual(ctx.map((m) => m.id), ['mA', 'mC'])                   // B not re-injected
  })

  await step('read/write isolation: mutating intents after commit or read results never rewrites storage', async () => {
    const s = sid()
    const r1 = rec('m1', 'original')
    const intent: OperationIntent = {
      kind: 'checkpoint', expectedRevision: null,
      changeSet: { kind: 'checkpoint', branchId: 'b1', newRecords: [r1], metadataPatch: {} },
    }
    await store.commit(s, prepareOperation(s, intent))
    ;(r1.message as { content: unknown }).content = 'hacked-intent'        // mutate the original intent
    const page = await store.loadHistory(s, 'b1')
    ;(page.records[0].message as { content: unknown }).content = 'hacked-read'   // mutate a read result
    assert.deepEqual((await store.loadContext(s, 'b1')).map((m) => m.content), ['original'])
    assert.deepEqual((await store.loadHistory(s, 'b1')).records.map((r) => r.message.content), ['original'])
  })

  await step('root deleted (non-cascade): registered child follow-up writes are rejected', async () => {
    const root = sid()
    const child = `conf-${counter}-child`
    await store.commit(root, prepareOperation(root, { kind: 'register', ownership: { rootSessionId: root } }))
    await store.saveTodos(child, prepareOperation(child, {
      kind: 'save-todos', todos: [], ownership: { rootSessionId: root, parentSessionId: root },
    }))
    await store.deleteSession(root, prepareOperation(root, { kind: 'delete' }))   // NON-cascade
    // follow-up todo write without explicit ownership must still validate stored ancestors
    await assert.rejects(() => store.saveTodos(child, prepareOperation(child, {
      kind: 'save-todos', todos: [{ content: 'late', status: 'pending', priority: 'high' }],
    })), /not authorized|registered/i)
    // follow-up transcript write likewise
    await assert.rejects(() => store.commit(child, prepareOperation(child, {
      kind: 'checkpoint', expectedRevision: null,
      changeSet: { kind: 'checkpoint', branchId: 'b1', newRecords: [rec('m1')], metadataPatch: {} },
    })), /not authorized|registered/i)
  })

  await step('zero-revision import is a real transcript: create-only NOT re-admitted', async () => {
    const s = sid()
    const legacy = rec('m1', 'legacy')
    await store.commit(s, prepareOperation(s, {
      kind: 'import', expectedRevision: null,
      changeSet: {
        kind: 'import', branchId: 'b1', newRecords: [legacy], effective: [legacy.recordId],
        context: { segments: [{ kind: 'records', recordIds: [legacy.recordId] }] },
        metadata: {}, ownership: { rootSessionId: s }, initialRevision: 0,
      },
    }))
    // transcript exists (branches non-empty) although revision === 0
    await assert.rejects(() => store.commit(s, prepareOperation(s, {
      kind: 'checkpoint', expectedRevision: null,
      changeSet: { kind: 'checkpoint', branchId: 'b1', newRecords: [rec('m2')], metadataPatch: {} },
    })), /conflict/i)
    await assert.rejects(() => store.commit(s, prepareOperation(s, {
      kind: 'import', expectedRevision: null,
      changeSet: {
        kind: 'import', branchId: 'b1', newRecords: [rec('m3')], effective: [],
        context: { segments: [] }, metadata: {}, ownership: { rootSessionId: s },
      },
    })), /conflict/i)
    // revision 0 remains a valid CAS premise for follow-up commits
    const r = await store.commit(s, prepareOperation(s, {
      kind: 'append', expectedRevision: 0,
      changeSet: { kind: 'append', branchId: 'b1', newRecords: [rec('m4')], contextAppend: true },
    }))
    assert.equal(r.revision, 1)
  })

  // ── 第二轮评审反例组（PR #132 复审 bf2c410） ──

  await step('fork/import cannot rewrite established ownership (immutability, spec §2.3)', async () => {
    const root = sid()
    const target = `conf-${counter}-t`
    await store.commit(root, prepareOperation(root, { kind: 'register', ownership: { rootSessionId: root } }))
    const one = rec('m1')
    await checkpoint(store, root, null, [one])                       // root gains a transcript for forking
    await store.saveTodos(target, prepareOperation(target, {        // target REGISTERED under root (todo-only)
      kind: 'save-todos', todos: [], ownership: { rootSessionId: root, parentSessionId: root },
    }))
    // fork into the registered target with a DIFFERENT ownership (root: itself) → rejected
    await assert.rejects(() => store.commit(target, prepareOperation(target, {
      kind: 'fork', expectedRevision: null,
      changeSet: {
        kind: 'fork', newSessionId: target, source: { sessionId: root, branchId: 'b1' }, sourceRevision: 1,
        records: [one.recordId], effective: [one.recordId],
        context: { segments: [{ kind: 'records', recordIds: [one.recordId] }] },
        metadata: {}, ownership: { rootSessionId: target },          // detach attempt
      },
    })), /ownership/i)
    // import likewise: cannot attach an unregistered root
    await assert.rejects(() => store.commit(target, prepareOperation(target, {
      kind: 'import', expectedRevision: null,
      changeSet: {
        kind: 'import', branchId: 'b1', newRecords: [rec('m2')], effective: [],
        context: { segments: [] }, metadata: {},
        ownership: { rootSessionId: 'unregistered-root' },
      },
    })), /ownership/i)
    // stored ownership unchanged
    assert.deepEqual((await store.loadSession(target))!.ownership, { rootSessionId: root, parentSessionId: root })
  })

  await step('prepare isolates ALL payload kinds (mutating original todos/ownership is safe)', async () => {
    const s = sid()
    const todos = [{ content: 'original', status: 'pending' as const, priority: 'high' as const }]
    const p = prepareOperation(s, { kind: 'save-todos', todos })
    todos[0].content = 'hacked'                                      // mutate the ORIGINAL array after prepare
    await store.saveTodos(s, p)                                      // frozen content still commits
    assert.equal((await store.loadTodos(s))[0].content, 'original')
    // register ownership likewise
    const rootX = `conf-${counter}-rx`
    await store.commit(rootX, prepareOperation(rootX, { kind: 'register', ownership: { rootSessionId: rootX } }))
    const s2 = `conf-${counter}-reg`
    const ownership = { rootSessionId: rootX, parentSessionId: rootX }
    const p2 = prepareOperation(s2, { kind: 'register', ownership })
    ownership.parentSessionId = 'hacked'
    await store.commit(s2, p2)
    assert.deepEqual((await store.loadSession(s2))!.ownership, { rootSessionId: rootX, parentSessionId: rootX })
  })

  await step('commit boundary rejects deserialized transcript prepared WITHOUT a revision premise', async () => {
    const s = sid()
    await checkpoint(store, s, null, [rec('m1')])                    // rev 1
    const p = prepareOperation(s, {
      kind: 'append', expectedRevision: 1,
      changeSet: { kind: 'append', branchId: 'b1', newRecords: [rec('m2')], contextAppend: true },
    })
    // simulate journal deserialization: strip the premise, recompute a CORRECT fingerprint
    // (fingerprint consistency ≠ structural legality — review S3)
    const stripped = { ...p, expectedRevision: undefined } as typeof p & { expectedRevision?: number }
    stripped.fingerprint = fingerprintOperation(s, stripped.kind, stripped.payload, undefined)
    await assert.rejects(() => store.commit(s, stripped as never), /expectedRevision/)
    assert.equal((await store.loadSession(s))!.revision, 1)          // no write happened
  })

  await step('rollback preserves original context SEGMENT order (per-segment rebuild)', async () => {
    const s = sid()
    // layout: logs [A, B, S, C]; effective [A,B,C]; context [records A, summary S(covers B), records C]
    const A = rec('mA', 'A')
    const B = rec('mB', 'B')
    const S = sum()
    const C = rec('mC', 'C')
    await store.commit(s, prepareOperation(s, {
      kind: 'checkpoint', expectedRevision: null,
      changeSet: {
        kind: 'checkpoint', branchId: 'b1', newRecords: [A, B, S, C],
        context: { segments: [
          { kind: 'records', recordIds: [A.recordId] },
          { kind: 'summary', summaryRecordId: S.recordId, covers: { branchId: 'b1', recordIds: [B.recordId] } },
          { kind: 'records', recordIds: [C.recordId] },
        ] },
        metadataPatch: {},
      },
    }))
    const intent = await planRollback(store, s, 'b1', 'mC')
    await store.commit(s, prepareOperation(s, intent as never))
    const state = await store.loadSession(s)
    const ctx = await store.loadContext(s, state!.currentBranchId)
    // ORIGINAL segment order preserved: [A, S(summary in place), C] — not [S, A, C]
    assert.deepEqual(ctx.map((m) => m.id), ['mA', S.message.id, 'mC'])
  })

  // ── 第三轮评审反例组（PR #132 复审 4e5ea71） ──

  await step('first-write ownership is cloned: mutating prepared.payload.ownership cannot detach cascade', async () => {
    const root = sid()
    await store.commit(root, prepareOperation(root, { kind: 'register', ownership: { rootSessionId: root } }))
    // (a) register-first child
    const child = `conf-${counter}-c`
    const p1 = prepareOperation(child, { kind: 'register', ownership: { rootSessionId: root, parentSessionId: root } })
    await store.commit(child, p1)
    ;(p1.payload as { ownership: { rootSessionId: string } }).ownership.rootSessionId = child   // reference attack
    assert.deepEqual((await store.loadSession(child))!.ownership, { rootSessionId: root, parentSessionId: root })
    // (b) saveTodos-first child (todo-only first write)
    const child2 = `conf-${counter}-c2`
    const p2 = prepareOperation(child2, { kind: 'save-todos', todos: [], ownership: { rootSessionId: root, parentSessionId: root } })
    await store.saveTodos(child2, p2)
    ;(p2.payload as { ownership?: { rootSessionId: string } }).ownership!.rootSessionId = child2
    assert.deepEqual((await store.loadSession(child2))!.ownership, { rootSessionId: root, parentSessionId: root })
    // cascade still reaches BOTH children (ownership was never actually detached)
    await store.deleteSession(root, prepareOperation(root, { kind: 'delete', cascadeOwned: true }))
    assert.equal(await store.loadSession(child), null)
    assert.equal(await store.loadSession(child2), null)
  })

  await step('premise-free kinds REJECT a deserialized expectedRevision (all three, fingerprint correctly recomputed)', async () => {
    const s = sid()
    await store.commit(s, prepareOperation(s, { kind: 'register', ownership: { rootSessionId: s } }))
    const cases: Array<{ make: () => PreparedOperation; submit: (p: PreparedOperation) => Promise<unknown> }> = [
      { make: () => prepareOperation(s, { kind: 'save-todos', todos: [] }), submit: (p) => store.saveTodos(s, p) },
      { make: () => prepareOperation(s, { kind: 'delete' }), submit: (p) => store.deleteSession(s, p) },
      { make: () => prepareOperation(s, { kind: 'register', ownership: { rootSessionId: s } }), submit: (p) => store.commit(s, p) },
    ]
    for (const c of cases) {
      const p = c.make()
      const forged = { ...p, expectedRevision: 12 } as typeof p & { expectedRevision?: number }
      forged.fingerprint = fingerprintOperation(s, forged.kind, forged.payload, 12)   // fingerprint IS correct
      await assert.rejects(() => c.submit(forged as never), /revision/)
    }
    // the forged delete did NOT delete anything
    assert.notEqual(await store.loadSession(s), null)
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

// ============================================================================
// P2 组（恢复协议：去重 / fencing / 保留窗口——spec §5/§6）
// ============================================================================

async function p2Step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch (err) {
    throw new Error(`[conformance p2] ${name}: ${(err as Error).message}`)
  }
}

let p2Counter = 0

async function p2Suite(ctx: P2TestContext): Promise<void> {
  const sid = () => `conf-p2-${++p2Counter}`
  const store = ctx.store
  /** 每个场景前重置 fencing 到初始授权（防状态污染）。 */
  const reset = () => ctx.rotateAuth(ctx.auth)
  /** 在 fenced store 上做提交的便捷方法（统一传 auth）。 */
  const commit = async (s: string, intent: OperationIntent) =>
    store.commit(s, prepareOperation(s, intent, { auth: ctx.auth }), { auth: ctx.auth })

  await p2Step('dedup: same-prepared retry returns original receipt, no re-apply', async () => {
    reset()
    const s = sid()
    const p = prepareOperation(s, {
      kind: 'checkpoint', expectedRevision: null,
      changeSet: { kind: 'checkpoint', branchId: 'b1', newRecords: [rec('m1')], metadataPatch: {} },
    }, { auth: ctx.auth })
    const r1 = await store.commit(s, p, { auth: ctx.auth })
    const r2 = await store.commit(s, p, { auth: ctx.auth })
    assert.equal(r2.committedAt, r1.committedAt)
    assert.equal((await store.loadSession(s))!.revision, 1)
  })

  await p2Step('dedup: tampered fingerprint → OperationConflictError', async () => {
    reset()
    const s = sid()
    const p1 = prepareOperation(s, {
      kind: 'checkpoint', expectedRevision: null,
      changeSet: { kind: 'checkpoint', branchId: 'b1', newRecords: [rec('m1')], metadataPatch: {} },
    }, { auth: ctx.auth })
    await store.commit(s, p1, { auth: ctx.auth })
    const p2 = { ...p1, payload: { ...(p1.payload as object), metadataPatch: { model: 'evil' } } } as typeof p1 & { expectedRevision?: number | null }
    p2.fingerprint = fingerprintOperation(s, p2.kind, p2.payload, p2.expectedRevision)
    await assert.rejects(() => store.commit(s, p2 as never, { auth: ctx.auth }), /conflict/i)
  })

  await p2Step('fencing: expired + nobody took over → all writes rejected', async () => {
    reset()
    const s = sid()
    await commit(s, {
      kind: 'checkpoint', expectedRevision: null,
      changeSet: { kind: 'checkpoint', branchId: 'b1', newRecords: [rec('m1')], metadataPatch: {} },
    })
    ctx.expireAuth()
    await assert.rejects(() => commit(s, {
      kind: 'checkpoint', expectedRevision: 1,
      changeSet: { kind: 'checkpoint', branchId: 'b1', newRecords: [rec('m2')], metadataPatch: {} },
    }), /fencing/i)
  })

  await p2Step('fencing §6.2: A→expire→B takeover→A rejected, B works', async () => {
    reset()
    const s = sid()
    await commit(s, {
      kind: 'checkpoint', expectedRevision: null,
      changeSet: { kind: 'checkpoint', branchId: 'b1', newRecords: [rec('m1')], metadataPatch: {} },
    })
    ctx.expireAuth()
    const authB = { ownerId: 'executor-B', epoch: 2 }
    ctx.rotateAuth(authB)
    await assert.rejects(() => store.commit(s, prepareOperation(s, {
      kind: 'checkpoint', expectedRevision: 1,
      changeSet: { kind: 'checkpoint', branchId: 'b1', newRecords: [rec('m2')], metadataPatch: {} },
    }, { auth: ctx.auth }), { auth: ctx.auth }), /fencing/i)
    const r = await store.commit(s, prepareOperation(s, {
      kind: 'checkpoint', expectedRevision: 1,
      changeSet: { kind: 'checkpoint', branchId: 'b1', newRecords: [rec('m3')], metadataPatch: {} },
    }, { auth: authB }), { auth: authB })
    assert.equal(r.revision, 2)
  })

  await p2Step('fencing independent from CAS: wrong auth + correct CAS → WriteNotAuthorizedError', async () => {
    reset()
    const s = sid()
    await commit(s, {
      kind: 'checkpoint', expectedRevision: null,
      changeSet: { kind: 'checkpoint', branchId: 'b1', newRecords: [rec('m1')], metadataPatch: {} },
    })
    await assert.rejects(() => store.commit(s, prepareOperation(s, {
      kind: 'checkpoint', expectedRevision: 1,
      changeSet: { kind: 'checkpoint', branchId: 'b1', newRecords: [rec('m2')], metadataPatch: {} },
    }, { auth: { ownerId: 'wrong', epoch: 99 } }), { auth: { ownerId: 'wrong', epoch: 99 } }), /fencing/i)
  })

  await p2Step('retention: past window + watermark NOT advanced → committed (pending unresolved)', async () => {
    reset()
    const s = sid()
    const r = await commit(s, {
      kind: 'checkpoint', expectedRevision: null,
      changeSet: { kind: 'checkpoint', branchId: 'b1', newRecords: [rec('m1')], metadataPatch: {} },
    })
    await ctx.elapseRetention()
    const q = await store.queryOperation(s, r.operationId)
    assert.equal(q.status, 'committed')
  })

  await p2Step('retention: past window + watermark advanced → recycled', async () => {
    reset()
    const s = sid()
    const r = await commit(s, {
      kind: 'checkpoint', expectedRevision: null,
      changeSet: { kind: 'checkpoint', branchId: 'b1', newRecords: [rec('m1')], metadataPatch: {} },
    })
    await ctx.elapseRetention()
    ctx.advanceWatermark()
    const q = await store.queryOperation(s, r.operationId)
    assert.equal(q.status, 'recycled')
  })

  await p2Step('retention watermark safety: advance, new commit, past window → still committed', async () => {
    reset()
    const s = sid()
    const r1 = await commit(s, {
      kind: 'checkpoint', expectedRevision: null,
      changeSet: { kind: 'checkpoint', branchId: 'b1', newRecords: [rec('m1')], metadataPatch: {} },
    })
    ctx.advanceWatermark()
    const r2 = await commit(s, {
      kind: 'checkpoint', expectedRevision: 1,
      changeSet: { kind: 'checkpoint', branchId: 'b1', newRecords: [rec('m2')], metadataPatch: {} },
    })
    await ctx.elapseRetention()
    assert.equal((await store.queryOperation(s, r1.operationId)).status, 'recycled')
    assert.equal((await store.queryOperation(s, r2.operationId)).status, 'committed')
  })

  // ── 全写入口覆盖（评审 R2：不只 checkpoint，todo/delete/register 也要验证） ──

  await p2Step('fencing expired: saveTodos and deleteSession also rejected', async () => {
    reset()
    const root = sid()
    const child = `${root}-sub`
    // Register root and child under root
    await store.commit(root, prepareOperation(root, { kind: 'register', ownership: { rootSessionId: root } }, { auth: ctx.auth }), { auth: ctx.auth })
    await store.saveTodos(child, prepareOperation(child, {
      kind: 'save-todos', todos: [], ownership: { rootSessionId: root, parentSessionId: root },
    }, { auth: ctx.auth }), { auth: ctx.auth })
    // Expire — nobody takes over
    ctx.expireAuth()
    // saveTodos with old auth → rejected
    await assert.rejects(() => store.saveTodos(child, prepareOperation(child, {
      kind: 'save-todos', todos: [{ content: 'late', status: 'pending', priority: 'high' }],
    }, { auth: ctx.auth }), { auth: ctx.auth }), /fencing/i)
    // deleteSession with old auth → rejected
    await assert.rejects(() => store.deleteSession(root, prepareOperation(root, {
      kind: 'delete',
    }, { auth: ctx.auth }), { auth: ctx.auth }), /fencing/i)
  })

  await p2Step('fencing expired: commit with NO auth also rejected', async () => {
    reset()
    const s = sid()
    await commit(s, {
      kind: 'checkpoint', expectedRevision: null,
      changeSet: { kind: 'checkpoint', branchId: 'b1', newRecords: [rec('m1')], metadataPatch: {} },
    })
    ctx.expireAuth()
    await assert.rejects(() => store.commit(s, prepareOperation(s, {
      kind: 'checkpoint', expectedRevision: 1,
      changeSet: { kind: 'checkpoint', branchId: 'b1', newRecords: [rec('m2')], metadataPatch: {} },
    })), /fencing/i)   // no auth at all — still rejected
  })

  await p2Step('fencing takeover: saveTodos with old auth rejected; new auth works', async () => {
    reset()
    const root = sid()
    const child = `${root}-sub`
    await store.commit(root, prepareOperation(root, { kind: 'register', ownership: { rootSessionId: root } }, { auth: ctx.auth }), { auth: ctx.auth })
    const authB = { ownerId: 'executor-B', epoch: 2 }
    ctx.expireAuth()
    ctx.rotateAuth(authB)
    // A's saveTodos rejected
    await assert.rejects(() => store.saveTodos(child, prepareOperation(child, {
      kind: 'save-todos', todos: [], ownership: { rootSessionId: root, parentSessionId: root },
    }, { auth: ctx.auth }), { auth: ctx.auth }), /fencing/i)
    // B's saveTodos works
    await store.saveTodos(child, prepareOperation(child, {
      kind: 'save-todos', todos: [], ownership: { rootSessionId: root, parentSessionId: root },
    }, { auth: authB }), { auth: authB })
  })

  await p2Step('dedup: saveTodos same-prepared retry returns original receipt', async () => {
    reset()
    const root = sid()
    const child = `${root}-sub`
    await store.commit(root, prepareOperation(root, { kind: 'register', ownership: { rootSessionId: root } }, { auth: ctx.auth }), { auth: ctx.auth })
    const tp = prepareOperation(child, {
      kind: 'save-todos', todos: [], ownership: { rootSessionId: root, parentSessionId: root },
    }, { auth: ctx.auth })
    const r1 = await store.saveTodos(child, tp, { auth: ctx.auth })
    const r2 = await store.saveTodos(child, tp, { auth: ctx.auth })   // retry same prepared
    assert.equal(r2.committedAt, r1.committedAt)
    assert.equal(r2.operationId, r1.operationId)
  })

  await p2Step('dedup: deleteSession same-prepared retry returns original receipt', async () => {
    reset()
    const s = sid()
    await store.commit(s, prepareOperation(s, { kind: 'register', ownership: { rootSessionId: s } }, { auth: ctx.auth }), { auth: ctx.auth })
    const dp = prepareOperation(s, { kind: 'delete' }, { auth: ctx.auth })
    const r1 = await store.deleteSession(s, dp, { auth: ctx.auth })
    assert.equal((r1.value as { deleted: boolean }).deleted, true)
    const r2 = await store.deleteSession(s, dp, { auth: ctx.auth })   // retry same prepared
    assert.equal(r2.committedAt, r1.committedAt)
    assert.equal(r2.operationId, r1.operationId)
  })

  await p2Step('dedup: register same-prepared retry returns original receipt', async () => {
    reset()
    const s = sid()
    const rp = prepareOperation(s, { kind: 'register', ownership: { rootSessionId: s } }, { auth: ctx.auth })
    const r1 = await store.commit(s, rp, { auth: ctx.auth })
    const r2 = await store.commit(s, rp, { auth: ctx.auth })
    assert.equal(r2.committedAt, r1.committedAt)
  })

  await p2Step('recycled receipt + same prepared retry → original receipt (cross-adapter dedup)', async () => {
    reset()
    const s = sid()
    const p = prepareOperation(s, {
      kind: 'checkpoint', expectedRevision: null,
      changeSet: { kind: 'checkpoint', branchId: 'b1', newRecords: [rec('m1')], metadataPatch: {} },
    }, { auth: ctx.auth })
    const r1 = await store.commit(s, p, { auth: ctx.auth })
    await ctx.elapseRetention()
    ctx.advanceWatermark()
    // Receipt is recycled...
    assert.equal((await store.queryOperation(s, r1.operationId)).status, 'recycled')
    // ...but dedup still returns the ORIGINAL receipt (operation was committed — not retryable)
    const r2 = await store.commit(s, p, { auth: ctx.auth })
    assert.equal(r2.committedAt, r1.committedAt)
    assert.equal(r2.revision, r1.revision)
  })

  await p2Step('valid auth: saveTodos and deleteSession actually work (positive path)', async () => {
    reset()
    const root = sid()
    const child = `${root}-sub`
    await store.commit(root, prepareOperation(root, { kind: 'register', ownership: { rootSessionId: root } }, { auth: ctx.auth }), { auth: ctx.auth })
    // saveTodos works with valid auth
    await store.saveTodos(child, prepareOperation(child, {
      kind: 'save-todos', todos: [{ content: 'ok', status: 'pending', priority: 'high' }],
      ownership: { rootSessionId: root, parentSessionId: root },
    }, { auth: ctx.auth }), { auth: ctx.auth })
    assert.equal((await store.loadTodos(child)).length, 1)
    // deleteSession works with valid auth
    const dr = await store.deleteSession(child, prepareOperation(child, {
      kind: 'delete',
    }, { auth: ctx.auth }), { auth: ctx.auth })
    assert.equal((dr.value as { deleted: boolean }).deleted, true)
    assert.equal(await store.loadSession(child), null)
  })
}

/** InMemory 默认 P2 工厂（App 的 SQLite adapter 需提供等价实现）。 */
export function createInMemoryP2Context(retentionMs?: number): P2TestContext {
  const initialAuth = { ownerId: 'conformance-executor', epoch: 1 }
  const store = new InMemorySessionStore({
    fencing: { initialAuth },
    ...(retentionMs !== undefined ? { receiptRetentionMs: retentionMs } : {}),
  })
  return {
    store,
    auth: initialAuth,
    expireAuth: () => store.expireAuthorization(),
    rotateAuth: (newAuth) => store.refreshAuthorization(newAuth),
    advanceWatermark: () => store.advanceRecyclingWatermark(store.getCommitUpperBound()),
    elapseRetention: async () => {
      if (retentionMs === undefined) throw new Error('retentionMs not configured')
      await new Promise((resolve) => setTimeout(resolve, retentionMs + 30))
    },
    getCommitUpperBound: () => store.getCommitUpperBound(),
  }
}
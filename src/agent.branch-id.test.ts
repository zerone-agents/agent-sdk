/**
 * Issue #145 回归：register-only 状态按契约返回 `currentBranchId: ''`（空串）——
 * Agent 的 `?? 'b1'` 不回退空串 → 首轮 checkpoint 提交空 branchId，严格 adapter
 * （如 App SQLite）拒绝 `branchId required`。验收 6 项 + InMemory 契约防御。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent, createAgent } from './agent.js'
import { InMemorySessionStore } from './store/in-memory.js'
import { WriteCoordinator } from './store/coordinator.js'
import { prepareOperation } from './store/prepare.js'
import { fingerprintOperation } from './store/fingerprint.js'
import { SessionDataInvalidError } from './store/errors.js'
import type { NewRecord, PreparedOperation } from './store/types.js'
import type { AgentOptions } from './types.js'
import type { NormalizedMessageParam } from './providers/types.js'

const msg = (mid: string, text = 'x'): NormalizedMessageParam =>
  ({ id: mid, role: 'user', content: text }) as NormalizedMessageParam

interface AgentInternals {
  setupDone: Promise<void>
  history: NormalizedMessageParam[]
  persistCheckpoint(): Promise<unknown>
  sessionRevision: number
  sid: string
}
const internals = (a: Agent): AgentInternals => a as unknown as AgentInternals

const base = (o: Partial<AgentOptions> = {}): AgentOptions =>
  ({ model: 'test-model', apiKey: 'fake', mcpServers: {}, ...o })

const rec = (rid: string, mid: string, text: string): NewRecord => ({
  recordId: rid,
  message: { id: mid, role: 'user', content: text },
  actor: { kind: 'main' },
})

/** App-SQLite-like strict store（issue #145）：拒绝空实体分支 id 的 commit（含 fork 嵌套 source）。 */
class StrictBranchStore extends InMemorySessionStore {
  override async commit(...args: Parameters<InMemorySessionStore['commit']>): ReturnType<InMemorySessionStore['commit']> {
    const payload = args[1] as unknown as { payload?: { branchId?: unknown; source?: { branchId?: unknown } } }
    const p = payload.payload
    if (p !== undefined && typeof p === 'object') {
      if ('branchId' in p && p.branchId === '') {
        throw new SessionDataInvalidError(args[0], 'branchId required')
      }
      if (p.source !== undefined && typeof p.source === 'object' && p.source.branchId === '') {
        throw new SessionDataInvalidError(args[0], 'source.branchId required')
      }
    }
    return super.commit(...args)
  }
}

describe('issue #145: empty branchId on first checkpoint (register-only state)', () => {
  it('acceptance 1: first checkpoint creates a NON-EMPTY branch (repro: was {"currentBranchId":"","branches":[""]})', async () => {
    const store = new InMemorySessionStore()
    const coord = new WriteCoordinator({ store })
    const agent = new Agent(base({ store, coordinator: coord }))
    const i = internals(agent)
    i.history = [msg('m1', 'first question'), msg('m2', 'answer')]
    await i.persistCheckpoint()
    const state = await store.loadSession(i.sid)
    expect(state).not.toBeNull()
    expect(state!.currentBranchId).not.toBe('')
    expect(state!.branches.map((b) => b.branchId)).not.toContain('')
    expect(state!.currentBranchId).toBe('b1')
    expect(state!.revision).toBe(1)
    // resume: context carries the first round
    const agent2 = new Agent(base({ store, coordinator: coord, resume: i.sid }))
    const i2 = internals(agent2)
    await i2.setupDone
    expect(i2.history.map((m) => (m as { id?: string }).id)).toEqual(['m1', 'm2'])
  })

  it('acceptance 2: explicit register-only → resume does not throw; first checkpoint non-empty', async () => {
    const store = new InMemorySessionStore()
    const coord = new WriteCoordinator({ store })
    await coord.execute('reg-only', { kind: 'register', ownership: { rootSessionId: 'reg-only' } })
    const agent = new Agent(base({ store, coordinator: coord, resume: 'reg-only' }))
    const i = internals(agent)
    await i.setupDone            // previously threw: loadContext(sid, '') → unknown branch
    expect(i.history).toEqual([])
    expect(i.sessionRevision).toBe(0)
    i.history = [msg('m1', 'after resume')]
    await i.persistCheckpoint()
    const state = await store.loadSession('reg-only')
    expect(state!.currentBranchId).not.toBe('')
  })

  it('acceptance 3: todos-first — register/todos stages stay branches=[]; checkpoint keeps todos + non-empty branch', async () => {
    const store = new InMemorySessionStore()
    const coord = new WriteCoordinator({ store })
    await coord.execute('todos-first', {
      kind: 'save-todos',
      todos: [{ content: 't1', status: 'pending', priority: 'high' }],
    })
    let state = await store.loadSession('todos-first')
    expect(state).not.toBeNull()
    expect(state!.branches).toEqual([])   // 登记阶段不建空转录（issue 约束）
    const agent = new Agent(base({ store, coordinator: coord, resume: 'todos-first' }))
    const i = internals(agent)
    await i.setupDone
    i.history = [msg('m1', 'q')]
    await i.persistCheckpoint()
    state = await store.loadSession('todos-first')
    expect(state!.currentBranchId).not.toBe('')
    expect(await store.loadTodos('todos-first')).toHaveLength(1)   // todos 不丢
  })

  it('acceptance 4: existing transcript (revision=0 import) keeps ITS branch — not misread as new session', async () => {
    const store = new InMemorySessionStore()
    const coord = new WriteCoordinator({ store })
    await coord.execute('imp-0', {
      kind: 'import', expectedRevision: null,
      changeSet: {
        kind: 'import', branchId: 'legacy-main',
        newRecords: [rec('r1', 'm1', 'old')],
        effective: ['r1'],
        context: { segments: [{ kind: 'records', recordIds: ['r1'] }] },
        metadata: {}, ownership: { rootSessionId: 'imp-0' }, initialRevision: 0,
      },
    })
    const agent = new Agent(base({ store, coordinator: coord, resume: 'imp-0' }))
    const i = internals(agent)
    await i.setupDone
    expect(i.sessionRevision).toBe(0)     // §8.3 legal revision-0 WITH transcript
    i.history = [...i.history, msg('m2', 'new')]
    await i.persistCheckpoint()
    const state = await store.loadSession('imp-0')
    expect(state!.branches.map((b) => b.branchId)).toEqual(['legacy-main'])   // keeps its ID
    expect(state!.revision).toBe(1)
  })

  it('acceptance 5: same-prepared retry does not duplicate (semantics unchanged)', async () => {
    const store = new InMemorySessionStore()
    let captured!: PreparedOperation
    const journal = {
      persist: async (p: PreparedOperation) => { captured = p },
      release: async () => {},
    }
    const coord = new WriteCoordinator({ store, journal })
    await coord.execute('dup', { kind: 'register', ownership: { rootSessionId: 'dup' } })
    await coord.execute('dup', {
      kind: 'checkpoint', expectedRevision: 0,
      changeSet: { kind: 'checkpoint', branchId: 'b1', newRecords: [rec('r1', 'm1', 'x')], metadataPatch: {} },
    })
    // captured = the checkpoint's prepared (last persist); retrying the SAME prepared dedups
    const again = await coord.retry('dup', captured)
    expect(again.revision ?? 1).toBe(1)
    const state = await store.loadSession('dup')
    expect(state!.branches[0]!.records).toHaveLength(1)   // no duplicate append
  })

  it('acceptance 6: STRICT adapter (rejects empty branchId) + real agent flow succeeds', async () => {
    const strict = new StrictBranchStore()
    const coord = new WriteCoordinator({ store: strict })
    const agent = new Agent(base({ store: strict, coordinator: coord }))
    const i = internals(agent)
    i.history = [msg('m1', 'q'), msg('m2', 'a')]
    await i.persistCheckpoint()   // previously: SessionDataInvalidError on the strict adapter
    const state = await strict.loadSession(i.sid)
    expect(state!.currentBranchId).not.toBe('')
    // close path also clean
    const agent3 = new Agent(base({ store: strict, coordinator: coord }))
    const i3 = internals(agent3)
    i3.history = [msg('m3', 'bye')]
    await agent3.close()
    expect((await strict.loadSession(i3.sid))!.currentBranchId).not.toBe('')
  })
})

describe('issue #145: empty-branchId contract defense (no lenient reference impl)', () => {
  it('empty branchId is rejected at PREPARE (fail-fast) or commit — never lands', async () => {
    const store = new InMemorySessionStore()
    await expect(async () => {
      await store.commit('s1', prepareOperation('s1', {
        kind: 'checkpoint', expectedRevision: null,
        changeSet: { kind: 'checkpoint', branchId: '', newRecords: [rec('r1', 'm1', 'x')], metadataPatch: {} },
      }))
    }).rejects.toThrow(SessionDataInvalidError)
  })

  it('rollback with empty newBranchId is rejected', async () => {
    const store = new InMemorySessionStore()
    await expect(async () => {
      await store.commit('s1', prepareOperation('s1', {
        kind: 'rollback', expectedRevision: null,
        changeSet: {
          kind: 'rollback', fromBranchId: 'b1', atMessageId: 'm1', newBranchId: '',
          records: ['r1'], effective: ['r1'],
          context: { segments: [{ kind: 'records', recordIds: ['r1'] }] },
        },
      }))
    }).rejects.toThrow(SessionDataInvalidError)
  })

  it('review P2: fork with empty source.branchId rejected at prepare AND commit; zero residue', async () => {
    const store = new InMemorySessionStore()
    const coord = new WriteCoordinator({ store })
    // Seed a legal source session (revision=1, branch b1)
    await coord.execute('source', {
      kind: 'checkpoint', expectedRevision: null,
      changeSet: { kind: 'checkpoint', branchId: 'b1', newRecords: [rec('r1', 'm1', 'x')], metadataPatch: {} },
    })
    // Layer 1: prepare rejects (fail-fast)
    await expect(async () => {
      prepareOperation('target', {
        kind: 'fork', expectedRevision: null,
        changeSet: {
          kind: 'fork', source: { sessionId: 'source', branchId: '' },
          sourceRevision: 1, newSessionId: 'target',
          records: [], effective: [], context: { segments: [] },
          metadata: {}, ownership: { rootSessionId: 'target' },
        },
      })
    }).rejects.toThrow(SessionDataInvalidError)
    // Layer 2: bypass prepare with a correct fingerprint → commit rejects; 零残留
    const payload = {
      kind: 'fork' as const, source: { sessionId: 'source', branchId: '' },
      sourceRevision: 1, newSessionId: 'target',
      records: [], effective: [], context: { segments: [] },
      metadata: {}, ownership: { rootSessionId: 'target' },
    }
    const hostile = {
      operationId: 'op-fork-empty-branch',
      sessionId: 'target', kind: 'fork', payload, expectedRevision: null,
      fingerprint: fingerprintOperation('target', 'fork', payload, null),
      actor: { kind: 'sdk' }, createdAt: new Date().toISOString(),
    } as unknown as PreparedOperation
    await expect(store.commit('target', hostile)).rejects.toThrow(SessionDataInvalidError)
    expect(await store.loadSession('target')).toBeNull()                     // 目标零残留
    expect(await store.queryOperation('target', 'op-fork-empty-branch')).toMatchObject({ status: 'not-committed' })
  })
})

describe('issue #145 review P2: PUBLIC flow regression (prompt → close → resume)', () => {
  it('real query round-trip on a strict store: non-empty branch, user+assistant persisted, resume carries context', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'sdk-pubflow-'))
    const originalFetch = globalThis.fetch
    const requestBodies: string[] = []
    // Deterministic openai-completions SSE stub（issue #145 复现脚本的形状）
    globalThis.fetch = (async (_input: unknown, init?: { body?: string }) => {
      if (typeof init?.body === 'string') requestBodies.push(init.body)
      return new Response([
        'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'answer' }, finish_reason: null }] }),
        'data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        'data: [DONE]',
      ].join('\n\n') + '\n\n', { headers: { 'content-type': 'text/event-stream' } })
    }) as typeof fetch
    try {
      const strict = new StrictBranchStore()
      const coord = new WriteCoordinator({ store: strict })
      const opts = (extra: Partial<AgentOptions> = {}): AgentOptions => ({
        model: 'test-model', apiKey: 'test',
        apiType: 'openai-completions',
        baseURL: 'https://sdk-test.invalid/v1',
        store: strict, coordinator: coord,
        settingSources: [],
        includePartialMessages: true,   // 走流式 createMessageStream（SSE stub 的解析路径）
        enableFileRevert: false,
        persistSession: true,
        cwd,
        mcpServers: {},
        ...extra,
      })
      // Round 1: PUBLIC prompt → close
      const agent1 = createAgent(opts({ sessionId: 'pub-flow' }))
      await agent1.prompt('first question')
      await agent1.close()
      const state = await strict.loadSession('pub-flow')
      expect(state?.currentBranchId).not.toBe('')
      // Real roles persisted: first-round user + assistant
      const ctx1 = await strict.loadContext('pub-flow', state!.currentBranchId)
      const roles = ctx1.map((m) => (m as { role?: string }).role)
      expect(roles).toContain('user')
      expect(roles).toContain('assistant')
      expect(ctx1.some((m) => JSON.stringify(m).includes('first question'))).toBe(true)
      // Round 2: NEW agent resumes → second prompt; the request carries the first round
      const agent2 = createAgent(opts({ resume: 'pub-flow' }))
      await agent2.prompt('second question')
      const lastBody = requestBodies[requestBodies.length - 1] ?? ''
      expect(lastBody).toContain('first question')
      // Branch stability: single branch, unchanged id（resume 不产生重复分支）
      const state2 = await strict.loadSession('pub-flow')
      expect(state2!.branches.map((b) => b.branchId)).toEqual([state!.currentBranchId])
    } finally {
      globalThis.fetch = originalFetch
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
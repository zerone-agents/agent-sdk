import { describe, expect, it } from 'vitest'
import { Agent } from './agent.js'
import { InMemorySessionStore } from './store/in-memory.js'
import { WriteCoordinator } from './store/coordinator.js'
import { WriteNotAuthorizedError } from './store/errors.js'
import { prepareOperation } from './store/prepare.js'
import type { AgentOptions } from './types.js'
import type { NormalizedMessageParam } from './providers/types.js'

const msg = (mid: string, text = 'x'): NormalizedMessageParam =>
  ({ id: mid, role: 'user', content: text }) as NormalizedMessageParam

interface AgentInternals {
  setupDone: Promise<void>
  history: NormalizedMessageParam[]
  persistCheckpoint(): Promise<void>
  sessionRevision: number
  rootSessionId: string
  sid: string
  v4Registered: boolean
}
const internals = (a: Agent): AgentInternals => a as unknown as AgentInternals

const base = (o: Partial<AgentOptions> = {}): AgentOptions =>
  ({ model: 'test-model', apiKey: 'fake', mcpServers: {}, ...o })

describe('Ownership propagation (issue #131 P3 T5)', () => {
  it('Task constructs ownership with correct root/parent/toolUseId', () => {
    const store = new InMemorySessionStore()
    const agent = new Agent(base({ store, ownership: { rootSessionId: 'app-root' } }))
    const i = internals(agent)
    // Agent's rootSessionId is the explicit root
    expect(i.rootSessionId).toBe('app-root')
    expect(i.rootSessionId).not.toBe(i.sid)  // root ≠ own sid for background agents
  })

  it('parent registers before child: child first todo write succeeds when parent registered via Task', async () => {
    const store = new InMemorySessionStore()
    const coord = new WriteCoordinator({ store })
    // Real usage: main agent IS the root — self-registers first (T3 wiring)
    const parentSid = 'parent-1'
    const rootSid = parentSid
    await coord.execute(parentSid, {
      kind: 'register',
      ownership: { rootSessionId: rootSid },
    })
    // Child tries first todo write — root/parent registered → succeeds
    await coord.execute('child-1', {
      kind: 'save-todos',
      todos: [{ content: 'child task', status: 'pending', priority: 'high' }],
      ownership: { rootSessionId: rootSid, parentSessionId: parentSid, parentToolUseId: 'tu-1' },
    })
    const child = await store.loadSession('child-1')
    expect(child).not.toBeNull()
    expect(child!.ownership).toEqual({ rootSessionId: rootSid, parentSessionId: parentSid, parentToolUseId: 'tu-1' })
  })

  it('root deleted → child late first write rejected, no residual row', async () => {
    const store = new InMemorySessionStore()
    const coord = new WriteCoordinator({ store })
    await coord.execute('root-1', { kind: 'register', ownership: { rootSessionId: 'root-1' } })
    // Delete root (non-cascade)
    await coord.execute('root-1', { kind: 'delete' })
    // Child tries to register under deleted root
    await expect(coord.execute('late-child', {
      kind: 'register',
      ownership: { rootSessionId: 'root-1', parentSessionId: 'root-1' },
    })).rejects.toThrow(WriteNotAuthorizedError)
    expect(await store.loadSession('late-child')).toBeNull()
  })

  it('nested subagent: root stays at app root, parent = direct parent', async () => {
    const store = new InMemorySessionStore()
    const coord = new WriteCoordinator({ store })
    // Register root
    await coord.execute('root', { kind: 'register', ownership: { rootSessionId: 'root' } })
    // Level 1 child
    await coord.execute('child-1', {
      kind: 'register',
      ownership: { rootSessionId: 'root', parentSessionId: 'root', parentToolUseId: 'tu-1' },
    })
    // Level 2 child (nested — root stays, parent = child-1)
    await coord.execute('child-2', {
      kind: 'register',
      ownership: { rootSessionId: 'root', parentSessionId: 'child-1', parentToolUseId: 'tu-2' },
    })
    const c2 = await store.loadSession('child-2')
    expect(c2!.ownership.rootSessionId).toBe('root')  // root unchanged
    expect(c2!.ownership.parentSessionId).toBe('child-1')  // parent = direct parent
  })

  it('cascade delete covers all owned sessions (including todo-only)', async () => {
    const store = new InMemorySessionStore()
    const coord = new WriteCoordinator({ store })
    await coord.execute('root', { kind: 'register', ownership: { rootSessionId: 'root' } })
    // Two children
    await coord.execute('c1', {
      kind: 'register',
      ownership: { rootSessionId: 'root', parentSessionId: 'root' },
    })
    await coord.execute('c2', {
      kind: 'save-todos',
      todos: [],
      ownership: { rootSessionId: 'root', parentSessionId: 'root' },
    })
    // Cascade delete
    await coord.execute('root', { kind: 'delete', cascadeOwned: true })
    expect(await store.loadSession('c1')).toBeNull()
    expect(await store.loadSession('c2')).toBeNull()
  })

  it('Agent self-registers before first checkpoint (root = own sid for main agent)', async () => {
    const store = new InMemorySessionStore()
    const coord = new WriteCoordinator({ store })
    const agent = new Agent(base({ store, coordinator: coord }))
    const i = internals(agent)
    i.history = [msg('m1')]
    await i.persistCheckpoint()
    // Agent should be registered
    expect(i.v4Registered).toBe(true)
    const state = await store.loadSession(i.sid)
    expect(state).not.toBeNull()
    expect(state!.ownership).toEqual({ rootSessionId: i.sid })  // main agent = own root
  })
})
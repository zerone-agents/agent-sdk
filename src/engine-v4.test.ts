import { describe, expect, it, vi } from 'vitest'
import { InMemorySessionStore } from './store/in-memory.js'
import { WriteCoordinator } from './store/coordinator.js'
import { prepareOperation } from './store/prepare.js'
import { TodoWriteTool } from './tools/todowrite.js'
import type { ToolContext } from './types.js'

const todo = (c: string) => ({ content: c, status: 'pending' as const, priority: 'high' as const })

describe('Engine + TodoWrite on v4 (issue #131 P3 T4)', () => {
  it('TodoWrite saves via coordinator when provided in context', async () => {
    const store = new InMemorySessionStore()
    const coordinator = new WriteCoordinator({ store })
    await store.commit('s1', prepareOperation('s1', { kind: 'register', ownership: { rootSessionId: 's1' } }))
    const ctx = {
      sessionId: 's1',
      store,
      coordinator,
    } as unknown as ToolContext
    const result = await TodoWriteTool.call({ todos: [todo('task')] }, ctx)
    expect(result.is_error).toBeFalsy()
    const loaded = await store.loadTodos('s1')
    expect(loaded).toHaveLength(1)
    expect(loaded[0].content).toBe('task')
  })

  it('TodoWrite without coordinator/store → is_error result', async () => {
    const ctx = { sessionId: 's1' } as unknown as ToolContext
    const result = await TodoWriteTool.call({ todos: [todo('x')] }, ctx)
    expect(result.is_error).toBe(true)
    expect(String(result.content)).toContain('coordinator')
  })

  it('TodoWrite with store but no coordinator → is_error (cannot write without coordinator)', async () => {
    const store = new InMemorySessionStore()
    const ctx = { sessionId: 's1', store } as unknown as ToolContext
    const result = await TodoWriteTool.call({ todos: [] }, ctx)
    expect(result.is_error).toBe(true)
  })

  it('TodoWrite with coordinator + fencing auth injected', async () => {
    const auth = { ownerId: 'test-exec', epoch: 1 }
    const store = new InMemorySessionStore({ fencing: { initialAuth: auth } })
    const coordinator = new WriteCoordinator({ store, fencing: { identity: auth } })
    await coordinator.execute('s1', { kind: 'register', ownership: { rootSessionId: 's1' } })
    const ctx = { sessionId: 's1', store, coordinator } as unknown as ToolContext
    const result = await TodoWriteTool.call({ todos: [todo('auth-test')] }, ctx)
    expect(result.is_error).toBeFalsy()
  })
})
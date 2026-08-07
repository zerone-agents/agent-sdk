import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext, ToolResult } from '../types.js'
import { formatTodosReminder } from './todowrite.js'

const mockContext: ToolContext = {
  cwd: '/tmp/test',
  agentId: 'test-agent',
  sessionId: 'test-session-001',
  subprocessEnv: { ...process.env },
}

describe('TodoWriteTool', () => {
  let TodoWriteTool: typeof import('./todowrite.js').TodoWriteTool
  let getTodos: typeof import('./todowrite.js').getTodos
  let clearTodos: typeof import('./todowrite.js').clearTodos

  beforeEach(async () => {
    vi.resetModules()
    const mod = await import('./todowrite.js')
    TodoWriteTool = mod.TodoWriteTool
    getTodos = mod.getTodos
    clearTodos = mod.clearTodos
  })

  describe('schema and metadata', () => {
    it('has correct tool name', () => {
      expect(TodoWriteTool.name).toBe('TodoWrite')
    })

    it('requires todos array in inputSchema', () => {
      expect(TodoWriteTool.inputSchema.required).toContain('todos')
    })

    it('defines status enum with 4 values', () => {
      const todoItemProps = TodoWriteTool.inputSchema.properties.todos.items.properties
      expect(todoItemProps.status.enum).toEqual(['pending', 'in_progress', 'completed', 'cancelled'])
    })

    it('defines priority enum with 3 values', () => {
      const todoItemProps = TodoWriteTool.inputSchema.properties.todos.items.properties
      expect(todoItemProps.priority.enum).toEqual(['high', 'medium', 'low'])
    })

    it('requires content, status, priority in each item', () => {
      const todoItemProps = TodoWriteTool.inputSchema.properties.todos.items
      expect(todoItemProps.required).toEqual(['content', 'status', 'priority'])
    })
  })

  describe('full-replace mode', () => {
    it('creates a new todo list from scratch', async () => {
      const result = await TodoWriteTool.call({
        todos: [
          { content: 'Task A', status: 'pending', priority: 'high' },
          { content: 'Task B', status: 'pending', priority: 'medium' },
        ],
      }, mockContext)

      expect(result.type).toBe('tool_result')
      expect(result.is_error).toBeFalsy()
      expect(result.content).toContain('Task A')
      expect(result.content).toContain('Task B')
    })

    it('replaces entire list on each call', async () => {
      await TodoWriteTool.call({
        todos: [
          { content: 'Old task', status: 'pending', priority: 'low' },
        ],
      }, mockContext)

      await TodoWriteTool.call({
        todos: [
          { content: 'New task', status: 'in_progress', priority: 'high' },
        ],
      }, mockContext)

      const todos = await getTodos('test-session-001')
      expect(todos).toHaveLength(1)
      expect(todos[0].content).toBe('New task')
    })

    it('handles empty todos array (clear all)', async () => {
      await TodoWriteTool.call({
        todos: [
          { content: 'Task', status: 'pending', priority: 'high' },
        ],
      }, mockContext)

      const result = await TodoWriteTool.call({ todos: [] }, mockContext)
      expect(result.is_error).toBeFalsy()

      const todos = await getTodos('test-session-001')
      expect(todos).toHaveLength(0)
    })
  })

  describe('session isolation', () => {
    it('keeps different sessions separate', async () => {
      const ctxA: ToolContext = { ...mockContext, sessionId: 'session-a' }
      const ctxB: ToolContext = { ...mockContext, sessionId: 'session-b' }

      await TodoWriteTool.call({
        todos: [{ content: 'Task A', status: 'pending', priority: 'high' }],
      }, ctxA)

      await TodoWriteTool.call({
        todos: [{ content: 'Task B', status: 'in_progress', priority: 'low' }],
      }, ctxB)

      const todosA = await getTodos('session-a')
      const todosB = await getTodos('session-b')

      expect(todosA).toHaveLength(1)
      expect(todosA[0].content).toBe('Task A')
      expect(todosB).toHaveLength(1)
      expect(todosB[0].content).toBe('Task B')
    })
  })

  describe('input validation', () => {
    it('rejects invalid status value', async () => {
      const result = await TodoWriteTool.call({
        todos: [{ content: 'Task', status: 'unknown', priority: 'high' }],
      }, mockContext)

      expect(result.is_error).toBe(true)
      expect(result.content).toContain('status')
    })

    it('rejects invalid priority value', async () => {
      const result = await TodoWriteTool.call({
        todos: [{ content: 'Task', status: 'pending', priority: 'urgent' }],
      }, mockContext)

      expect(result.is_error).toBe(true)
      expect(result.content).toContain('priority')
    })

    it('rejects empty content', async () => {
      const result = await TodoWriteTool.call({
        todos: [{ content: '', status: 'pending', priority: 'high' }],
      }, mockContext)

      expect(result.is_error).toBe(true)
      expect(result.content).toContain('content')
    })

    it('rejects missing todos field', async () => {
      const result = await TodoWriteTool.call({}, mockContext)

      expect(result.is_error).toBe(true)
    })

    it('rejects path traversal in sessionId', async () => {
      const evilContext: ToolContext = { ...mockContext, sessionId: '../../etc' }
      const result = await TodoWriteTool.call({
        todos: [{ content: 'Evil', status: 'pending', priority: 'high' }],
      }, evilContext)

      expect(result.is_error).toBe(true)
      expect(result.content).toContain('sessionId')
    })

    it('rejects sessionId with special characters', async () => {
      const evilContext: ToolContext = { ...mockContext, sessionId: 'session;rm -rf /' }
      const result = await TodoWriteTool.call({
        todos: [{ content: 'Evil', status: 'pending', priority: 'high' }],
      }, evilContext)

      expect(result.is_error).toBe(true)
    })
  })

  describe('output formatting', () => {
    it('includes formatted text with content', async () => {
      const result = await TodoWriteTool.call({
        todos: [
          { content: 'Done task', status: 'completed', priority: 'high' },
          { content: 'Active task', status: 'in_progress', priority: 'medium' },
          { content: 'Pending task', status: 'pending', priority: 'low' },
          { content: 'Cancelled task', status: 'cancelled', priority: 'medium' },
        ],
      }, mockContext)

      expect(result.is_error).toBeFalsy()
      const output = typeof result.content === 'string' ? result.content : JSON.stringify(result.content)
      expect(output).toContain('Done task')
      expect(output).toContain('Active task')
      expect(output).toContain('Pending task')
      expect(output).toContain('Cancelled task')
    })

    it('includes structured metadata for UI rendering', async () => {
      const todos = [
        { content: 'Task 1', status: 'pending', priority: 'high' },
      ]

      const result = await TodoWriteTool.call({ todos }, mockContext)
      expect(result.metadata).toBeDefined()
      expect((result.metadata as any).todos).toEqual(todos)
    })

    it('renders each todo with status keyword and priority in trailing brackets', async () => {
      const result = await TodoWriteTool.call({
        todos: [
          { content: 'Task 1', status: 'completed', priority: 'high' },
          { content: 'Task 2', status: 'pending', priority: 'medium' },
          { content: 'Task 3', status: 'in_progress', priority: 'low' },
        ],
      }, mockContext)

      const output = typeof result.content === 'string' ? result.content : JSON.stringify(result.content)
      expect(output).toContain('1. Task 1 [completed|high]')
      expect(output).toContain('2. Task 2 [pending|medium]')
      expect(output).toContain('3. Task 3 [in_progress|low]')
    })
  })

  describe('persistence', () => {
    it('survives module reload (reads from file)', async () => {
      await TodoWriteTool.call({
        todos: [
          { content: 'Persistent task', status: 'pending', priority: 'high' },
        ],
      }, mockContext)

      vi.resetModules()
      const mod2 = await import('./todowrite.js')

      const todos = await mod2.getTodos('test-session-001')
      expect(todos).toHaveLength(1)
      expect(todos[0].content).toBe('Persistent task')
    })
  })

  describe('public API', () => {
    it('getTodos returns empty array for unknown session', async () => {
      const todos = await getTodos('nonexistent-session')
      expect(todos).toEqual([])
    })

    it('clearTodos removes all todos for a session', async () => {
      await TodoWriteTool.call({
        todos: [{ content: 'Task', status: 'pending', priority: 'high' }],
      }, mockContext)

      await clearTodos('test-session-001')

      const todos = await getTodos('test-session-001')
      expect(todos).toHaveLength(0)
    })
  })
})

describe('formatTodosReminder', () => {
  it('emits each status keyword verbatim (no glyph mapping)', () => {
    const todos = [
      { content: 'p', status: 'pending' as const, priority: 'low' as const },
      { content: 'i', status: 'in_progress' as const, priority: 'medium' as const },
      { content: 'c', status: 'completed' as const, priority: 'high' as const },
      { content: 'x', status: 'cancelled' as const, priority: 'medium' as const },
    ]
    const out = formatTodosReminder(todos)
    expect(out).toContain('[pending|low]')
    expect(out).toContain('[in_progress|medium]')
    expect(out).toContain('[completed|high]')
    expect(out).toContain('[cancelled|medium]')
  })

  it('wraps lines in <system-reminder> with 2-space indent', () => {
    const out = formatTodosReminder([
      { content: 'task', status: 'pending', priority: 'high' },
    ])
    expect(out.startsWith('<system-reminder>\n  Current task list:\n')).toBe(true)
    expect(out.endsWith('\n</system-reminder>')).toBe(true)
    // The single todo line must be 2-space indented and match the format spec.
    // Use endsWith to avoid matching 'Current task list:' (which also contains 'task').
    const bodyLine = out.split('\n').find((l) => l.endsWith('[pending|high]'))!
    expect(bodyLine).toMatch(/^\s{2}\d+\. .+ \[(pending|in_progress|completed|cancelled)\|(high|medium|low)\]$/)
  })

  it('produces valid scaffolding for empty input (defensive)', () => {
    const out = formatTodosReminder([])
    expect(out).toContain('<system-reminder>')
    expect(out).toContain('Current task list:')
    expect(out).toContain('</system-reminder>')
    // No todo-numbered lines.
    expect(out.split('\n').find((l) => l.match(/^\s+\d+\./))).toBeUndefined()
  })
})

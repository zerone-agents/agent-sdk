import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ToolDefinition, ToolContext, ToolResult } from '../types.js'
import { TODO_PRIORITIES, TODO_STATUSES, type TodoInfo } from '../types.js'
import { defaultSessionStorage } from '../session-storage.js'

export type { TodoInfo, TodoStatus, TodoPriority } from '../types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

let _description: string
try {
  _description = readFileSync(join(__dirname, 'todowrite.txt'), 'utf-8')
} catch {
  _description = 'Manage a structured task list for your current coding session.'
}

function validateTodos(todos: any[]): string | null {
  if (!Array.isArray(todos)) return 'todos must be an array'

  for (let i = 0; i < todos.length; i++) {
    const item = todos[i]
    if (!item.content || typeof item.content !== 'string' || item.content.trim() === '') {
      return `todos[${i}].content must be a non-empty string`
    }
    if (!TODO_STATUSES.includes(item.status)) {
      return `todos[${i}].status must be one of: ${TODO_STATUSES.join(', ')}`
    }
    if (!TODO_PRIORITIES.includes(item.priority)) {
      return `todos[${i}].priority must be one of: ${TODO_PRIORITIES.join(', ')}`
    }
  }

  const inProgressCount = todos.filter((t: any) => t.status === 'in_progress').length
  if (inProgressCount > 1) {
    return `Warning: ${inProgressCount} tasks are in_progress. Only one should be in_progress at a time.`
  }

  return null
}

function formatTodos(todos: TodoInfo[]): string {
  if (todos.length === 0) return 'No todos.'
  return todos
    .map((t, i) => `${i + 1}. ${t.content} [${t.status}|${t.priority}]`)
    .join('\n')
}

export function formatTodosReminder(todos: TodoInfo[]): string {
  const lines = todos.map(
    (t, i) => `  ${i + 1}. ${t.content} [${t.status}|${t.priority}]`,
  )
  return [
    '<system-reminder>',
    '  Current task list:',
    ...lines,
    '</system-reminder>',
  ].join('\n')
}

/**
 * @deprecated 仅操作默认文件存储（`~/.agents/sessions/<sid>/todos.json`）——
 * 不会使用 Agent 注入的自定义 storage。改用
 * `createSessionManager({ storage }).getTodos/clearTodos`（issue #128）。
 */
export async function getTodos(sessionId: string): Promise<TodoInfo[]> {
  return defaultSessionStorage.loadTodos(sessionId)
}

/** @deprecated 同上——改用 SessionManager（issue #128）。 */
export async function clearTodos(sessionId: string): Promise<void> {
  return defaultSessionStorage.saveTodos(sessionId, [])
}

/**
 * Whether a todo list contains any non-terminal item (pending / in_progress).
 * Used by the engine's per-turn reminder injection (issue #32): an all-terminal
 * list (completed/cancelled) belongs to the previous query and must neither be
 * injected into the next model request nor left polluting the persisted store.
 */
export function hasActiveTodos(todos: TodoInfo[]): boolean {
  return todos.some((t) => t.status === 'pending' || t.status === 'in_progress')
}

export const TodoWriteTool: ToolDefinition = {
  name: 'TodoWrite',
  description: _description,
  inputSchema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The updated todo list',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Brief description of the task' },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed', 'cancelled'],
              description: 'Current status of the task',
            },
            priority: {
              type: 'string',
              enum: ['high', 'medium', 'low'],
              description: 'Priority level of the task',
            },
          },
          required: ['content', 'status', 'priority'],
        },
      },
    },
    required: ['todos'],
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() {
    return _description
  },
  async call(input: any, context: ToolContext): Promise<ToolResult> {
    const todos = input.todos
    if (!Array.isArray(todos)) {
      return { type: 'tool_result', tool_use_id: '', content: 'todos must be an array', is_error: true }
    }

    const validationError = validateTodos(todos)
    if (validationError && validationError.startsWith('todos[')) {
      return { type: 'tool_result', tool_use_id: '', content: validationError, is_error: true }
    }

    const sessionId = context.sessionId || 'default'

    // Tool-layer format guard (defense in depth — the storage boundary
    // validates too, issue #128).
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
      return { type: 'tool_result', tool_use_id: '', content: `Invalid sessionId: ${sessionId}. Must match /^[a-zA-Z0-9_-]+$/`, is_error: true }
    }

    const storage = context.sessionStorage
    if (!storage) {
      return { type: 'tool_result', tool_use_id: '', content: 'TodoWrite requires a session storage context (missing sessionStorage).', is_error: true }
    }

    await storage.saveTodos(sessionId, todos)

    const formatted = formatTodos(todos)
    const warning = validationError ? `\n\nNote: ${validationError}` : ''

    return {
      type: 'tool_result',
      tool_use_id: '',
      content: formatted + warning,
      metadata: { todos },
    }
  },
}

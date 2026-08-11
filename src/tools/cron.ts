/**
 * Cron/Scheduling Tools
 *
 * CronCreate, CronDelete, CronList - Schedule recurring tasks.
 * RemoteTrigger - Manage remote scheduled agent triggers.
 */

import type { ToolDefinition, ToolResult, ToolContext } from '../types.js'
import type { CronTask } from '../cron/types.js'
import type { CronStorage } from '../cron/storage.js'
import {
  parseCronExpression,
  computeNextCronRun,
  cronToHuman,
} from '../cron/cron.js'

let storage: CronStorage | null = null

export type CronJob = CronTask

export function initCronTools(
  storageImpl: CronStorage,
  agents?: Record<string, { description: string }>
): void {
  storage = storageImpl
  if (agents) {
    CronCreateTool.description = buildCronCreateDescription(agents)
  }
}

function buildCronCreateDescription(
  agents: Record<string, { description: string }>
): string {
  const agentLines = Object.entries(agents)
    .map(([id, def]) => `- "${id}": ${def.description}`)
    .join('\n')

  return (
    'Create a recurring scheduled task. Provide a 5-field cron expression (e.g. "*/5 * * * *").\n' +
    'Always prefer this tool over system schedulers like `at`, `crontab`, or `sleep`.\n\n' +
    '**IMPORTANT: Agent selection rule (MANDATORY)** — You MUST analyze the task content and set the `agent` field to the best-matching agent ID. ' +
    'If you do not provide an agent, the task creation will fail.\n\n' +
    'Available agents:\n' +
    agentLines
  )
}

function notInitializedResult(): ToolResult {
  return {
    type: 'tool_result',
    tool_use_id: '',
    content: 'Cron storage is not initialized.',
    is_error: true,
  }
}

function formatPrompt(prompt: string): string {
  return prompt.length > 80 ? `${prompt.slice(0, 77)}...` : prompt
}

/**
 * Get all cron jobs.
 */
export async function getAllCronJobs(): Promise<CronTask[]> {
  if (!storage) return []
  return storage.load()
}

/**
 * Clear all cron jobs.
 */
export async function clearCronJobs(): Promise<void> {
  if (!storage) return
  await storage.save([])
}

export const CronCreateTool: ToolDefinition = {
  name: 'CronCreate',
  description:
    'Create a recurring scheduled task. Provide a 5-field cron expression (e.g. "*/5 * * * *").\n' +
    'Always prefer this tool over system schedulers like `at`, `crontab`, or `sleep`.\n\n' +
    '**Agent selection** — Analyze the task content and set the `agent` field to the best-matching agent ID. ' +
    'If omitted, the current conversation agent is used automatically.\n' +
    'Do NOT embed agent role instructions in the prompt — the selected agent will automatically apply its own system prompt and tools.',
  shortDescription: 'Schedule a recurring task with a cron expression (e.g. every N minutes, daily at 9am)',
  deferred: true,
  inputSchema: {
    type: 'object',
    properties: {
      cron: {
        type: 'string',
        description: '5-field cron expression (e.g. "*/5 * * * *").',
      },
      prompt: { type: 'string', description: 'Prompt to execute when the task fires. Write only the task itself — do NOT include agent role instructions (the `agent` field handles that).' },
      agent: {
        type: 'string',
        description: 'Agent ID to execute this task. Analyze the task content and select the best-matching agent from the list above. If omitted, defaults to the current conversation agent.',
      },
    },
    required: ['cron', 'prompt'],
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() { return 'Create a scheduled cron task.' },
  async call(input: any, context: ToolContext): Promise<ToolResult> {
    const cronStorage = storage
    if (!cronStorage) return notInitializedResult()

    if (typeof input?.cron !== 'string' || typeof input?.prompt !== 'string') {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: 'CronCreate requires cron and prompt fields.',
        is_error: true,
      }
    }

    const fields = parseCronExpression(input.cron)
    if (!fields) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `Invalid cron expression: "${input.cron}". Must be a valid 5-field cron (e.g. "0 16 * * *").`,
        is_error: true,
      }
    }

    const nextRun = computeNextCronRun(fields, new Date())
    if (!nextRun) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `Cron expression has no matching run time within 366 days: ${input.cron}`,
        is_error: true,
      }
    }

    const tasks = await cronStorage.load()
    if (tasks.length >= 50) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: 'Cron task limit reached: maximum 50 tasks.',
        is_error: true,
      }
    }

    const task: Omit<CronTask, 'id' | 'createdAt'> = {
      cron: input.cron,
      prompt: input.prompt,
    }

    const resolvedAgent = typeof input.agent === 'string' && input.agent
      ? input.agent
      : context.agentId
    task.agentId = resolvedAgent

    const id = await cronStorage.add(task)
    const description = cronToHuman(input.cron)
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const localTimeStr = nextRun.toLocaleString('zh-CN', {timeZone, hour12: false}) 

    return {
      type: 'tool_result',
      tool_use_id: '',
      content: `Cron task created: ${id} (${description}). Next run: ${localTimeStr} (${timeZone})`,
    }
  },
}

export const CronDeleteTool: ToolDefinition = {
  name: 'CronDelete',
  description: 'Delete a scheduled cron task.',
  shortDescription: 'Delete a scheduled cron task by its task ID',
  deferred: true,
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Cron task ID to delete' },
    },
    required: ['id'],
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() { return 'Delete a cron task.' },
  async call(input: any): Promise<ToolResult> {
    const cronStorage = storage
    if (!cronStorage) return notInitializedResult()

    if (typeof input?.id !== 'string') {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: 'CronDelete requires an id field.',
        is_error: true,
      }
    }

    const tasks = await cronStorage.load()
    if (!tasks.some((task) => task.id === input.id)) {
      return { type: 'tool_result', tool_use_id: '', content: `Cron task not found: ${input.id}`, is_error: true }
    }

    await cronStorage.remove([input.id])
    return { type: 'tool_result', tool_use_id: '', content: `Cron task deleted: ${input.id}` }
  },
}

export const CronListTool: ToolDefinition = {
  name: 'CronList',
  description: 'List all scheduled cron tasks.',
  shortDescription: 'List all currently scheduled cron tasks with their next-fire times',
  deferred: true,
  inputSchema: { type: 'object', properties: {} },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() { return 'List cron tasks.' },
  async call(): Promise<ToolResult> {
    const cronStorage = storage
    if (!cronStorage) return notInitializedResult()

    const tasks = await cronStorage.load()
    if (tasks.length === 0) {
      return { type: 'tool_result', tool_use_id: '', content: 'No cron tasks scheduled.' }
    }

    const lines = tasks.map((task) => {
      let line = `[${task.id}] ${cronToHuman(task.cron)} cron="${task.cron}" prompt="${formatPrompt(task.prompt)}"`;
      if (task.agentId) {
        line += ` agent="${task.agentId}"`;
      }
      return line;
    })
    return { type: 'tool_result', tool_use_id: '', content: lines.join('\n') }
  },
}

/**
 * 这个tool是一个占位符，用于在远程环境中管理定时触发器（RemoteTrigger）。在本地SDK模式下，它不会执行实际的调度操作，而是提示用户需要连接远程后端来使用此功能。
 */
// export const RemoteTriggerTool: ToolDefinition = {
//   name: 'RemoteTrigger',
//   description: 'Manage remote scheduled agent triggers. Supports list, get, create, update, and run operations.',
//   inputSchema: {
//     type: 'object',
//     properties: {
//       action: {
//         type: 'string',
//         enum: ['list', 'get', 'create', 'update', 'run'],
//         description: 'Operation to perform',
//       },
//       id: { type: 'string', description: 'Trigger ID (for get/update/run)' },
//       name: { type: 'string', description: 'Trigger name (for create)' },
//       schedule: { type: 'string', description: 'Cron schedule (for create/update)' },
//       prompt: { type: 'string', description: 'Agent prompt (for create/update)' },
//     },
//     required: ['action'],
//   },
//   isReadOnly: () => false,
//   isConcurrencySafe: () => true,
//   isEnabled: () => true,
//   async prompt() { return 'Manage remote agent triggers.' },
//   async call(input: any): Promise<ToolResult> {
//     // RemoteTrigger operations are typically handled by the remote backend
//     // In standalone SDK mode, we provide a stub implementation
//     return {
//       type: 'tool_result',
//       tool_use_id: '',
//       content: `RemoteTrigger ${input.action}: This feature requires a connected remote backend. In standalone SDK mode, use CronCreate/CronList/CronDelete for local scheduling.`,
//     }
//   },
// }

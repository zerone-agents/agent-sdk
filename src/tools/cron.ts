/**
 * Cron/Scheduling Tools
 *
 * CronCreate, CronDelete, CronList — thin adapters over CronService
 * (issue #42: the single entry shared by SDK Tools and host APIs).
 * runNow/update/get/listExecutions are host-only and deliberately NOT tools.
 */

import type { ToolDefinition, ToolResult, ToolContext } from '../types.js'
import type { CronService } from '../cron/service.js'
import { computeNextCronRun, cronToHuman, parseCronExpression } from '../cron/cron.js'

let cronService: CronService | null = null

export function initCronTools(
  service: CronService,
  agents?: Record<string, { description: string }>,
): void {
  cronService = service
  if (agents) {
    CronCreateTool.description = buildCronCreateDescription(agents)
  }
}

function buildCronCreateDescription(
  agents: Record<string, { description: string }>,
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
    content: 'Cron service is not initialized.',
    is_error: true,
  }
}

function errorResult(message: string): ToolResult {
  return { type: 'tool_result', tool_use_id: '', content: message, is_error: true }
}

function formatPrompt(prompt: string): string {
  return prompt.length > 80 ? `${prompt.slice(0, 77)}...` : prompt
}

export const CronCreateTool: ToolDefinition = {
  name: 'CronCreate',
  description:
    'Create a recurring scheduled task. Provide a 5-field cron expression (e.g. "*/5 * * * *").\n' +
    'Always prefer this tool over system schedulers like `at`, `crontab`, or `sleep`.\n\n' +
    '**Agent selection** — Analyze the task content and set the `agent` field to the best-matching agent ID. ' +
    'If omitted, the current conversation agent is used automatically.\n' +
    'Do NOT embed agent role instructions in the prompt — the selected agent will automatically apply its own system prompt and tools.',
  shortDescription:
    'Schedule a recurring task with a cron expression (e.g. every N minutes, daily at 9am)',
  deferred: true,
  inputSchema: {
    type: 'object',
    properties: {
      cron: {
        type: 'string',
        description: '5-field cron expression (e.g. "*/5 * * * *").',
      },
      prompt: {
        type: 'string',
        description:
          'Prompt to execute when the task fires. Write only the task itself — do NOT include agent role instructions (the `agent` field handles that).',
      },
      name: {
        type: 'string',
        description: 'Optional short display name for the task.',
      },
      agent: {
        type: 'string',
        description:
          'Agent ID to execute this task. Analyze the task content and select the best-matching agent from the list above. If omitted, defaults to the current conversation agent.',
      },
    },
    required: ['cron', 'prompt'],
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() {
    return 'Create a scheduled cron task.'
  },
  async call(input: any, context: ToolContext): Promise<ToolResult> {
    const service = cronService
    if (!service) return notInitializedResult()

    if (typeof input?.cron !== 'string' || typeof input?.prompt !== 'string') {
      return errorResult('CronCreate requires cron and prompt fields.')
    }

    try {
      const task = await service.create({
        cron: input.cron,
        prompt: input.prompt,
        ...(typeof input.name === 'string' && input.name ? { name: input.name } : {}),
        agentId:
          typeof input.agent === 'string' && input.agent ? input.agent : context.agentId,
      })

      const description = cronToHuman(task.cron)
      const fields = parseCronExpression(task.cron)
      const nextRun = fields ? computeNextCronRun(fields, new Date()) : null
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
      const localTimeStr = nextRun
        ? nextRun.toLocaleString('zh-CN', { timeZone, hour12: false })
        : 'unknown'

      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `Cron task created: ${task.id} (${description}). Next run: ${localTimeStr} (${timeZone})`,
      }
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
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
  async prompt() {
    return 'Delete a cron task.'
  },
  async call(input: any): Promise<ToolResult> {
    const service = cronService
    if (!service) return notInitializedResult()

    if (typeof input?.id !== 'string') {
      return errorResult('CronDelete requires an id field.')
    }

    try {
      await service.delete(input.id)
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `Cron task deleted: ${input.id}`,
      }
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }
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
  async prompt() {
    return 'List cron tasks.'
  },
  async call(): Promise<ToolResult> {
    const service = cronService
    if (!service) return notInitializedResult()

    try {
      const tasks = await service.list()
      if (tasks.length === 0) {
        return { type: 'tool_result', tool_use_id: '', content: 'No cron tasks scheduled.' }
      }

      const lines = tasks.map((task) => {
        let line = `[${task.id}]${task.name ? ` "${task.name}"` : ''} ${cronToHuman(task.cron)} cron="${task.cron}" prompt="${formatPrompt(task.prompt)}"`
        if (task.agentId) {
          line += ` agent="${task.agentId}"`
        }
        return line
      })
      return { type: 'tool_result', tool_use_id: '', content: lines.join('\n') }
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }
  },
}

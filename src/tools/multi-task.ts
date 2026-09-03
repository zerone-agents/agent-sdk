import type { ToolDefinition, ToolContext, ToolResult, SubagentContext } from '../types.js'
import { runSubagent } from './spawn-subagent.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const MULTITASK_DESCRIPTION = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'multi-task.txt'),
  'utf-8',
).trim()

function validateSubagentType(subagentType: any): string | null {
  const type = subagentType || 'General'
  if (type !== 'Explore' && type !== 'General') {
    return `Invalid subagent_type "${type}". Must be either 'Explore' or 'General'.`
  }
  return null
}

interface SubtaskResult {
  status: 'completed' | 'failed' | 'aborted'
  index: number
  description: string
  output: string | null
  error: string | null
  toolsUsed: string[]
  sessionId: string
  maxTurnsHit: boolean
}

export const MultiTaskTool: ToolDefinition = {
  name: 'MultiTask',
  description: MULTITASK_DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        description: 'List of independent subtasks to run in parallel',
        minItems: 1,
        maxItems: 10,
        items: {
          type: 'object',
          properties: {
            description: {
              type: 'string',
              description: 'Short (3-5 word) description of this subtask',
            },
            prompt: {
              type: 'string',
              description: 'The task for this subagent to perform',
            },
            subagent_type: {
              type: 'string',
              enum: ['Explore', 'General'],
              description: "Agent mode: 'Explore' (read-only) or 'General' (full capabilities). Defaults to 'General'.",
            },
            subagent_name: {
              type: 'string',
              description: 'Registered agent name to use. Defaults to parent agentId.',
            },
          },
          required: ['description', 'prompt'],
        },
      },
    },
    required: ['tasks'],
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
  async call(input: any, context: ToolContext): Promise<ToolResult> {
    const ctx = context as SubagentContext
    const toolUseId = context.toolUseId || ''
    const tasks = input.tasks

    if (!Array.isArray(tasks) || tasks.length === 0) {
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: 'Error: tasks must be a non-empty array.',
        is_error: true,
      }
    }

    if (tasks.length > 10) {
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: 'Error: tasks array must not exceed 10 items.',
        is_error: true,
      }
    }

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i]
      if (!task.prompt || typeof task.prompt !== 'string') {
        return {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: `Error: task[${i}] is missing prompt.`,
          is_error: true,
        }
      }
      if (!task.description || typeof task.description !== 'string') {
        return {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: `Error: task[${i}] is missing description.`,
          is_error: true,
        }
      }
      const typeError = validateSubagentType(task.subagent_type)
      if (typeError) {
        return {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: `Error: task[${i}] ${typeError}`,
          is_error: true,
        }
      }
    }

    const executions = tasks.map(async (task, index): Promise<SubtaskResult> => {
      const baseResult = { index, description: task.description }
      const run = await runSubagent({
        runtime: ctx.runtime,
        subAgents: ctx.subAgents,
        agentName: task.subagent_name,
        fallbackAgentId: context.agentId,
        mode: task.subagent_type || 'General',
        prompt: task.prompt,
        description: task.description,
        toolUseId,
        taskIndex: index,
        abortSignal: context.abortSignal,
        diagnostics: context.diagnostics, // #78: child inherits diagnostics
        emitEvent: ctx.emitEvent ? (event) => ctx.emitEvent?.(event) : undefined,
      })
      return {
        ...baseResult,
        status: run.status,
        output: run.output,
        error: run.error,
        toolsUsed: run.toolsUsed,
        sessionId: run.sessionId,
        maxTurnsHit: run.maxTurnsHit,
      }
    })

    const settled = await Promise.allSettled(executions)
    const results = settled
      .map((r): SubtaskResult => {
        if (r.status === 'fulfilled') return r.value
        return {
          status: 'failed',
          index: -1,
          description: '',
          output: null,
          error: `Unexpected error: ${r.reason}`,
          toolsUsed: [],
          sessionId: '',
          maxTurnsHit: false,
        }
      })
      .sort((a, b) => a.index - b.index)

    // Plain-text result: markdown summary of completed subtasks + failure appendix.
    // The result is consumed by the parent LLM, not parsed by code — no JSON wrapper.
    const sections: string[] = []
    const completedOutputs = results
      .filter(r => r.status === 'completed' && r.output)
      .map(r => `## ${r.description}\n\n${r.output}`)
    if (completedOutputs.length > 0) {
      sections.push(
        `Aggregated results across ${completedOutputs.length} completed subtask(s):\n\n` +
        completedOutputs.join('\n\n---\n\n'),
      )
    }

    const failed = results.filter(r => r.status !== 'completed')
    if (failed.length > 0) {
      const lines = failed.map(r => {
        const suffix = r.status === 'aborted' ? ' [aborted]' : ''
        return `- ${r.description}${suffix}: ${r.error || '(no error message)'}`
      })
      sections.push(`Failed subtasks:\n${lines.join('\n')}`)
    }

    const allFailed = results.length > 0 && !results.some(r => r.status === 'completed')
    // maxTurnsHit on any subtask counts as a failure for is_error purposes,
    // mirroring the Task tool (where maxTurnsHit → is_error: true).
    const anyMaxTurnsHit = results.some(r => r.maxTurnsHit)
    const content = sections.length > 0
      ? sections.join('\n\n')
      : 'All subtasks failed without producing any output.'

    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content,
      is_error: allFailed || anyMaxTurnsHit,
    }
  },
}

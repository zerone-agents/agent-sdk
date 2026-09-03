import type { ToolDefinition, ToolContext, ToolResult, SubagentContext } from '../types.js'
import { runSubagent } from './spawn-subagent.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const TASK_DESCRIPTION = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'task.txt'),
  'utf-8',
).trim()

export const TaskTool: ToolDefinition = {
  name: 'Task',
  description: TASK_DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'The task for the agent to perform',
      },
      description: {
        type: 'string',
        description: 'A short (3-5 word) description of the task',
      },
      subagent_type: {
        type: 'string',
        enum: ['Explore', 'General'],
        description: "Agent mode: 'Explore' (read-only) or 'General' (full capabilities)",
      },
      subagent_name: {
        type: 'string',
        description: 'Registered agent name from the subAgents table. If omitted, the parent agent\'s agentId is used to look up the table; the call fails if no matching entry exists.',
      },
    },
    required: ['prompt', 'description', 'subagent_type'],
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
  async call(input: any, context: ToolContext): Promise<ToolResult> {
    const ctx = context as SubagentContext
    const toolUseId = context.toolUseId || ''

    // Validate subagent_type
    if (!input.subagent_type) {
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: "Error: subagent_type is required. Must be either 'Explore' or 'General'.",
        is_error: true,
      }
    }
    if (input.subagent_type !== 'Explore' && input.subagent_type !== 'General') {
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: `Error: Invalid subagent_type "${input.subagent_type}". Must be either 'Explore' or 'General'.`,
        is_error: true,
      }
    }

    const run = await runSubagent({
      runtime: ctx.runtime,
      subAgents: ctx.subAgents,
      agentName: input.subagent_name,
      fallbackAgentId: context.agentId,
      mode: input.subagent_type,
      prompt: input.prompt,
      description: input.description,
      toolUseId,
      taskIndex: 0,
      abortSignal: context.abortSignal,
      diagnostics: context.diagnostics, // #78: child inherits diagnostics
      emitEvent: ctx.emitEvent
        ? (event) => ctx.emitEvent?.(event)
        : undefined,
    })

    if (run.status !== 'completed') {
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: run.error ?? '(Subagent failed without error message)',
        is_error: true,
      }
    }

    const toolSummary = run.toolsUsed.length > 0
      ? `\n[Tools used: ${run.toolsUsed.join(', ')}]`
      : ''
    const maxTurnsWarning = run.maxTurnsHit
      ? `\n[Warning: Subagent reached max turns limit. Result may be incomplete.]`
      : ''

    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: (run.output ?? '(Subagent completed with no text output)') + toolSummary + maxTurnsWarning,
      is_error: run.maxTurnsHit,
    }
  },
}

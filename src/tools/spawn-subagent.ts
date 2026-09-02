/**
 * Subagent spawn factory — shared by TaskTool and MultiTaskTool.
 *
 * Intentional design decisions (see spec 2026-07-27-tools-skills-params-refactor-design.md):
 * - Subagent canUseTool is allow-all: we do NOT want permission prompts
 *   interrupting a Task phase.
 * - Task and MultiTask are removed from the subagent tool pool at build
 *   time: nesting is forbidden by design.
 */

import type {
  AgentDefinition,
  AgentEnvironment,
  ResolvedAgent,
  RuntimeEnvironment,
  SDKSubagentMessage,
  ToolDefinition,
} from '../types.js'
import { QueryEngine } from '../engine.js'
import { resolveAgent } from '../resolve-agent.js'
import { resolvePrompt } from '../prompts/system-prompts.js'

export const DEFAULT_SUBAGENT_MAX_TURNS = 10

export type SpawnSubagentMode = 'Explore' | 'General'

const EXPLORE_RESTRICTION_PROMPT = `
You are running in Explore mode. You can only read files, search code, and run non-mutating shell commands. Do NOT modify, create, or delete any files. Do NOT write or edit code. Focus on exploration and information gathering only.`

const FALLBACK_PROMPT = 'You are a helpful assistant. Complete the given task using the available tools.'

const PROPAGATED_EVENT_TYPES = ['assistant', 'partial_message', 'tool_result', 'system', 'result']

export interface SpawnSubagentOptions {
  env: AgentEnvironment
  /** Runtime-global environment (issue #72); replaces env in 3.0 */
  runtime: RuntimeEnvironment
  subAgents: Record<string, AgentDefinition>
  agentName?: string
  fallbackAgentId: string
  mode: SpawnSubagentMode
  prompt: string
  description: string
  toolUseId: string
  taskIndex: number
  abortSignal?: AbortSignal
  emitEvent?: (event: SDKSubagentMessage) => void
}

export interface SubagentRun {
  status: 'completed' | 'failed' | 'aborted'
  output: string | null
  error: string | null
  toolsUsed: string[]
  sessionId: string
  maxTurnsHit: boolean
  maxTurns: number
}

function isReadOnlyTool(tool: ToolDefinition): boolean {
  const ro = typeof tool.isReadOnly === 'function' ? tool.isReadOnly() : tool.isReadOnly
  return ro === true
}

/** Tools for a spawned subagent: resolved pool minus Task/MultiTask, Explore further restricted to read-only + Bash. */
export function buildSubagentTools(
  env: AgentEnvironment,
  definition: AgentDefinition,
  mode: SpawnSubagentMode,
): ToolDefinition[] {
  const { tools } = resolveAgent(env, definition)
  let pool = tools.filter((t) => t.name !== 'Task' && t.name !== 'MultiTask')
  if (mode === 'Explore') {
    pool = pool.filter((t) => isReadOnlyTool(t) || t.name === 'Bash')
  }
  return pool
}

/** System prompt for a spawned subagent; Explore mode appends the restriction notice. */
export function buildSubagentSystemPrompt(
  definition: AgentDefinition,
  mode: SpawnSubagentMode,
): string {
  const base = resolvePrompt(definition.prompt) ?? FALLBACK_PROMPT
  return mode === 'Explore' ? base + '\n' + EXPLORE_RESTRICTION_PROMPT : base
}

export async function runSubagent(opts: SpawnSubagentOptions): Promise<SubagentRun> {
  const agentName = opts.agentName || opts.fallbackAgentId

  const baseRun = {
    toolsUsed: [] as string[],
    sessionId: '',
    maxTurnsHit: false,
    maxTurns: DEFAULT_SUBAGENT_MAX_TURNS,
  }

  if (!agentName) {
    return {
      ...baseRun,
      status: 'failed',
      output: null,
      error: 'Error: No agent name resolved. Provide subagent_name or ensure parent agent has an agentId.',
    }
  }

  const agentDef = opts.subAgents[agentName]
  if (!agentDef) {
    const available = Object.keys(opts.subAgents)
    return {
      ...baseRun,
      status: 'failed',
      output: null,
      error: `Error: Agent "${agentName}" is not registered.${available.length > 0 ? ` Available agents: ${available.join(', ')}` : ''}`,
    }
  }

  const maxTurns = agentDef.maxTurns ?? DEFAULT_SUBAGENT_MAX_TURNS
  const baseResolution = resolveAgent(opts.env, agentDef)
  const resolved: ResolvedAgent = {
    definition: { ...agentDef, prompt: buildSubagentSystemPrompt(agentDef, opts.mode) },
    tools: buildSubagentTools(opts.env, agentDef, opts.mode),
    skills: baseResolution.skills,
    deferredTools: [],  // sub-agent tools are resolved above without split; this stays empty
    services: baseResolution.services,
    skillRegistry: baseResolution.skillRegistry,
  }

  const sessionId = crypto.randomUUID()

  const engine = new QueryEngine({
    env: opts.env,
    runtime: opts.runtime,
    resolved,
    agentId: agentName,
    maxTurns,
    // Intentional: subagents auto-allow all tools — a Task phase must not be
    // interrupted by permission prompts.
    canUseTool: async () => ({ behavior: 'allow' }),
    includePartialMessages: true,
    sessionId,
    abortSignal: opts.abortSignal,
  })

  // subtask_completed is emitted exactly once for every post-spawn terminal state.
  const finish = (r: SubagentRun): SubagentRun => {
    opts.emitEvent?.({
      type: 'subagent',
      parent_tool_use_id: opts.toolUseId,
      session_id: sessionId,
      task_index: opts.taskIndex,
      task_description: opts.description,
      event: {
        type: 'subtask_completed',
        status: r.status,
        output: r.output,
        error: r.error,
        toolsUsed: r.toolsUsed,
        maxTurnsHit: r.maxTurnsHit,
      },
    })
    return r
  }

  const toolCalls = new Set<string>()
  let resultText = ''
  let endSubtype = 'success'
  let maxTurnsHit = false
  let aborted = false
  let eventCount = 0

  try {
    for await (const event of engine.submitMessage(opts.prompt)) {
      eventCount++
      if (opts.abortSignal?.aborted) {
        aborted = true
        break
      }

      if (event.type === 'assistant') {
        for (const block of event.message.content) {
          if (block.type === 'tool_use' && typeof block.name === 'string' && block.name) {
            toolCalls.add(block.name)
          }
          if (block.type === 'text' && block.text) {
            resultText += block.text
          }
        }
      }

      if (event.type === 'result') {
        const subtype = (event as any).subtype || 'success'
        if (subtype === 'error_max_turns') maxTurnsHit = true
        endSubtype = subtype
      }

      if (opts.emitEvent && PROPAGATED_EVENT_TYPES.includes(event.type)) {
        opts.emitEvent({
          type: 'subagent',
          parent_tool_use_id: opts.toolUseId,
          session_id: sessionId,
          task_index: opts.taskIndex,
          task_description: opts.description,
          event: event as any,
        })
      }
    }
  } catch (err: any) {
    return finish({
      status: 'failed',
      output: null,
      error: `Subagent error: ${err.message}`,
      toolsUsed: [...toolCalls],
      sessionId,
      maxTurnsHit: false,
      maxTurns,
    })
  }

  const common = {
    toolsUsed: [...toolCalls],
    sessionId,
    maxTurns,
  }

  const isEngineError = endSubtype.startsWith('error_') && endSubtype !== 'error_max_turns'
  if (isEngineError) {
    return finish({
      ...common,
      status: 'failed',
      output: resultText || null,
      error: `Subagent engine ended with subtype "${endSubtype}".`,
      maxTurnsHit: false,
    })
  }

  if (eventCount === 0) {
    return finish({
      ...common,
      status: 'failed',
      output: null,
      error: 'QueryEngine produced no events. Likely a provider initialization failure, network error, or rate limit.',
      toolsUsed: [],
      maxTurnsHit: false,
    })
  }

  if (!aborted && !maxTurnsHit && !resultText && toolCalls.size === 0) {
    return finish({
      ...common,
      status: 'failed',
      output: null,
      error: 'Subagent completed without producing any text or tool calls. This may indicate a provider error, rate limit, budget exhaustion, or an empty model response.',
      maxTurnsHit: false,
    })
  }

  if (aborted) {
    return finish({
      ...common,
      status: 'aborted',
      output: resultText || null,
      error: 'Subagent aborted by parent signal.',
      maxTurnsHit: false,
    })
  }

  if (maxTurnsHit) {
    return finish({
      ...common,
      status: 'completed',
      output: resultText || `(Subagent hit max turns (${maxTurns}) without producing text output)`,
      error: null,
      maxTurnsHit: true,
    })
  }

  return finish({
    ...common,
    status: 'completed',
    output: resultText || '(Subagent completed with no text output)',
    error: null,
    maxTurnsHit: false,
  })
}

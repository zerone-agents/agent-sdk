import { createAgent, type Agent } from '../agent.js'
import type { AgentOptions } from '../types.js'
import type { CronExecutionTrigger, CronTask } from './types.js'

/**
 * Port: runs one scheduled task. Executors must respect the AbortSignal
 * (timeout / suspend / stop) and return the execution output. They never
 * manage scheduling or persistence.
 */
export type CronExecutor = (
  task: CronTask,
  context: {
    executionId: string
    trigger: CronExecutionTrigger
    signal: AbortSignal
  },
) => Promise<{ output?: string }>

/**
 * Resolves the CURRENT agent definition for a fire. Called on every
 * execution — credentials, models, and tools are never persisted in the
 * task (issue #42), so long-lived tasks always run the latest config.
 */
export type CronAgentResolver = (agentId?: string) => Promise<AgentOptions>

type CreateAgentFn = (options: AgentOptions) => Agent

/**
 * Default executor: resolve -> createAgent -> run the prompt -> collect the
 * last assistant text -> close. Resolver/agent errors propagate (the
 * Coordinator records `failed`; the task stays schedulable).
 */
export function createDefaultAgentCronExecutor(
  resolveAgent: CronAgentResolver,
  opts?: { createAgentFn?: CreateAgentFn },
): CronExecutor {
  const create = opts?.createAgentFn ?? createAgent
  return async (task, context) => {
    const options = await resolveAgent(task.agentId)
    const agent = create(options)
    try {
      const abort = new AbortController()
      const forward = () => abort.abort(context.signal.reason)
      if (context.signal.aborted) forward()
      else context.signal.addEventListener('abort', forward, { once: true })

      let lastText = ''
      for await (const event of agent.query(task.prompt, { abortController: abort })) {
        if ((event as { type?: string }).type === 'assistant') {
          const text = extractAssistantText(
            (event as { message?: unknown }).message,
          )
          if (text) lastText = text
        }
      }
      return { output: lastText || undefined }
    } finally {
      await agent.close()
    }
  }
}

function extractAssistantText(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter(
        (block): block is { type: 'text'; text: string } =>
          (block as { type?: string }).type === 'text',
      )
      .map((block) => block.text)
      .join('')
  }
  return ''
}

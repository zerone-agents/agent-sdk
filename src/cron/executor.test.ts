import { describe, expect, it, vi } from 'vitest'

import { createDefaultAgentCronExecutor } from './executor.js'
import type { Agent } from '../agent.js'
import type { AgentOptions } from '../types.js'
import type { CronTask } from './types.js'

const task: CronTask = {
  id: 't1',
  cron: '* * * * *',
  prompt: 'run report',
  createdAt: 0,
  agentId: 'finance',
}

function fakeAgent(calls: {
  prompts: string[]
  closed: () => void
  events?: () => AsyncGenerator<{ type: string; message?: unknown }>
  onQuery?: () => void
}): (options: AgentOptions) => Agent {
  return () =>
    ({
      query: async function* (_prompt: string) {
        calls.onQuery?.()
        calls.prompts.push(_prompt)
        yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'final text' }] } }
      },
      close: async () => { calls.closed() },
    }) as unknown as Agent
}

describe('createDefaultAgentCronExecutor', () => {
  it('resolves the agent by task.agentId and returns the last assistant text', async () => {
    const prompts: string[] = []
    let closed = 0
    const resolve = vi.fn(async (_agentId?: string) => ({ agentId: 'x' }) as AgentOptions)
    const executor = createDefaultAgentCronExecutor(resolve, {
      createAgentFn: fakeAgent({ prompts, closed: () => { closed++ } }),
    })

    const result = await executor(task, {
      executionId: 'e1',
      trigger: 'scheduled',
      signal: new AbortController().signal,
    })

    expect(resolve).toHaveBeenCalledWith('finance')
    expect(prompts).toEqual(['run report'])
    expect(result.output).toBe('final text')
    expect(closed).toBe(1)
  })

  it('re-resolves on every execution (no caching)', async () => {
    const resolve = vi.fn(async () => ({}) as AgentOptions)
    const executor = createDefaultAgentCronExecutor(resolve, {
      createAgentFn: fakeAgent({ prompts: [], closed: () => {} }),
    })
    const ctx = { executionId: 'e', trigger: 'scheduled' as const, signal: new AbortController().signal }

    await executor(task, ctx)
    await executor(task, ctx)

    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('rejects when the resolver fails (execution -> failed, task survives)', async () => {
    const resolve = async () => { throw new Error('no such agent') }
    const executor = createDefaultAgentCronExecutor(resolve, {
      createAgentFn: () => { throw new Error('must not be called') },
    })

    await expect(
      executor(task, { executionId: 'e1', trigger: 'scheduled', signal: new AbortController().signal }),
    ).rejects.toThrow('no such agent')
  })

  it('closes the agent even when the query throws', async () => {
    let closed = 0
    const create = () =>
      ({
        query: async function* () { throw new Error('model exploded') },
        close: async () => { closed++ },
      }) as unknown as Agent
    const executor = createDefaultAgentCronExecutor(async () => ({}), { createAgentFn: create })

    await expect(
      executor(task, { executionId: 'e1', trigger: 'scheduled', signal: new AbortController().signal }),
    ).rejects.toThrow('model exploded')
    expect(closed).toBe(1)
  })

  it('forwards abort to the agent query controller', async () => {
    const outer = new AbortController()
    let sawAborted = false
    const create = () =>
      ({
        query: async function* (_p: string, overrides?: { abortController?: AbortController }) {
          const inner = overrides?.abortController
          if (inner) {
            inner.signal.addEventListener('abort', () => { sawAborted = true })
            outer.abort()
            await new Promise((r) => setTimeout(r, 0))
            expect(sawAborted).toBe(true)
          }
          yield { type: 'assistant', message: { role: 'assistant', content: 'text' } }
        },
        close: async () => {},
      }) as unknown as Agent
    const executor = createDefaultAgentCronExecutor(async () => ({}), { createAgentFn: create })

    await executor(task, { executionId: 'e1', trigger: 'scheduled', signal: outer.signal })
  })

  it('concatenates text blocks of the last assistant message', async () => {
    const create = () =>
      ({
        query: async function* () {
          yield {
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: 'part one ' }, { type: 'text', text: 'part two' }] },
          }
        },
        close: async () => {},
      }) as unknown as Agent
    const executor = createDefaultAgentCronExecutor(async () => ({}), { createAgentFn: create })

    const result = await executor(task, {
      executionId: 'e1',
      trigger: 'scheduled',
      signal: new AbortController().signal,
    })

    expect(result.output).toBe('part one part two')
  })
})

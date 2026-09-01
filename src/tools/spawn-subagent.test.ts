import { describe, it, expect, beforeEach, vi } from 'vitest'
import type {
  ToolDefinition,
  AgentEnvironment,
  AgentDefinition,
  SDKSubagentMessage,
} from '../types.js'

// Mock QueryEngine to avoid real LLM calls — must be a constructor (used with `new`)
vi.mock('../engine.js', () => ({
  QueryEngine: vi.fn(),
}))

// Mock tools index to provide controlled tool set without circular dependency.
// resolveAgent (via buildSubagentTools) needs all three exports.
const MOCK_TOOLS: ToolDefinition[] = [
  { name: 'Read', isReadOnly: () => true, call: vi.fn() } as any,
  { name: 'Glob', isReadOnly: () => true, call: vi.fn() } as any,
  { name: 'Grep', isReadOnly: () => true, call: vi.fn() } as any,
  { name: 'Bash', isReadOnly: () => false, call: vi.fn() } as any,
  { name: 'Write', isReadOnly: () => false, call: vi.fn() } as any,
  { name: 'Edit', isReadOnly: () => false, call: vi.fn() } as any,
  { name: 'Task', isReadOnly: () => false, call: vi.fn() } as any,
  { name: 'MultiTask', isReadOnly: () => false, call: vi.fn() } as any,
]

// resolveAgent (via buildSubagentTools) consumes getAllBaseTools +
// assembleToolPool + applyAllowedTools/applyDisallowedTools. Spread the real
// implementations and only override getAllBaseTools so the tool pool is
// predictable while the rest of the resolution pipeline (including the real
// wildcard filtering semantics) stays intact.
vi.mock('./index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./index.js')>()
  return {
    ...actual,
    getAllBaseTools: () => [...MOCK_TOOLS],
  }
})

const { QueryEngine } = await import('../engine.js')
const {
  runSubagent,
  buildSubagentTools,
  DEFAULT_SUBAGENT_MAX_TURNS,
} = await import('./spawn-subagent.js')

const env = {
  provider: {} as any,
  model: 'test-model',
  maxTokens: 4096,
  cwd: '/tmp',
  customTools: [],
  mcpTools: [],
  skillRegistry: { getUserInvocable: () => [] } as any,
  subprocessEnv: {},
} as AgentEnvironment

const AGENTS: Record<string, AgentDefinition> = {
  explorer: { description: 'Explores things', prompt: 'You explore.' },
}

let capturedConfig: any

function baseOpts(overrides: Partial<Parameters<typeof runSubagent>[0]> = {}) {
  return {
    env,
    subAgents: AGENTS,
    agentName: 'explorer',
    fallbackAgentId: 'explorer',
    mode: 'General' as const,
    prompt: 'do the thing',
    description: 'task desc',
    toolUseId: 'toolu_1',
    taskIndex: 0,
    ...overrides,
  }
}

describe('runSubagent', () => {
  beforeEach(() => {
    capturedConfig = undefined
    ;(QueryEngine as any).mockReset()
  })

  it('returns failed without emitting when the agent is not registered', async () => {
    const events: SDKSubagentMessage[] = []
    const run = await runSubagent(
      baseOpts({
        agentName: 'missing',
        subAgents: AGENTS,
        emitEvent: (e) => events.push(e),
      }),
    )

    expect(run.status).toBe('failed')
    expect(run.sessionId).toBe('')
    expect(run.error).toContain('"missing"')
    expect(run.error).toContain('not registered')
    expect(events).toHaveLength(0)
  })

  it('completes normally: output text, toolsUsed, exactly one subtask_completed with wrapper fields', async () => {
    ;(QueryEngine as any).mockImplementation(function (this: any, config: any) {
      capturedConfig = config
      this.submitMessage = async function* () {
        yield {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', name: 'Read' },
              { type: 'text', text: 'all done' },
            ],
          },
        }
        yield { type: 'result', subtype: 'success' }
      }
    })

    const events: SDKSubagentMessage[] = []
    const run = await runSubagent(baseOpts({ emitEvent: (e) => events.push(e) }))

    expect(run.status).toBe('completed')
    expect(run.output).toBe('all done')
    expect(run.error).toBeNull()
    expect(run.toolsUsed).toEqual(['Read'])
    expect(run.sessionId).not.toBe('')
    expect(run.maxTurnsHit).toBe(false)
    expect(run.maxTurns).toBe(DEFAULT_SUBAGENT_MAX_TURNS)

    const completed = events.filter((e) => e.event.type === 'subtask_completed')
    expect(completed).toHaveLength(1)
    const wrapper = completed[0]
    expect(wrapper.type).toBe('subagent')
    expect(wrapper.parent_tool_use_id).toBe('toolu_1')
    expect(wrapper.task_index).toBe(0)
    expect(wrapper.task_description).toBe('task desc')
    expect(wrapper.session_id).toBe(run.sessionId)
    expect(wrapper.event).toMatchObject({ type: 'subtask_completed', status: 'completed' })

    // Propagated stream events (assistant + result) are also wrapped and emitted
    const propagated = events.filter((e) => e.event.type !== 'subtask_completed')
    expect(propagated.map((e) => e.event.type)).toEqual(['assistant', 'result'])
    expect(propagated.every((e) => e.parent_tool_use_id === 'toolu_1')).toBe(true)
  })

  it('returns failed and emits failed when the engine throws', async () => {
    ;(QueryEngine as any).mockImplementation(function (this: any, config: any) {
      capturedConfig = config
      this.submitMessage = async function* () {
        throw new Error('boom')
      }
    })

    const events: SDKSubagentMessage[] = []
    const run = await runSubagent(baseOpts({ emitEvent: (e) => events.push(e) }))

    expect(run.status).toBe('failed')
    expect(run.error).toContain('boom')
    expect(run.sessionId).not.toBe('')

    const completed = events.filter((e) => e.event.type === 'subtask_completed')
    expect(completed).toHaveLength(1)
    expect(completed[0].event).toMatchObject({ type: 'subtask_completed', status: 'failed' })
  })

  it('treats error_max_turns as completed with maxTurnsHit', async () => {
    ;(QueryEngine as any).mockImplementation(function (this: any, config: any) {
      capturedConfig = config
      this.submitMessage = async function* () {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'partial' }] },
        }
        yield { type: 'result', subtype: 'error_max_turns' }
      }
    })

    const events: SDKSubagentMessage[] = []
    const run = await runSubagent(baseOpts({ emitEvent: (e) => events.push(e) }))

    expect(run.status).toBe('completed')
    expect(run.maxTurnsHit).toBe(true)
    expect(run.output).toBe('partial')

    const completed = events.filter((e) => e.event.type === 'subtask_completed')
    expect(completed).toHaveLength(1)
    expect(completed[0].event).toMatchObject({
      type: 'subtask_completed',
      status: 'completed',
      maxTurnsHit: true,
    })
  })

  it('builds the tool pool: General drops Task/MultiTask; Explore keeps only read-only + Bash', () => {
    const general = buildSubagentTools(env, AGENTS.explorer, 'General').map((t) => t.name)
    expect(general).not.toContain('Task')
    expect(general).not.toContain('MultiTask')
    expect(general).toContain('Write')
    expect(general).toContain('Bash')

    const explore = buildSubagentTools(env, AGENTS.explorer, 'Explore').map((t) => t.name)
    expect(explore).toContain('Read')
    expect(explore).toContain('Glob')
    expect(explore).toContain('Grep')
    expect(explore).toContain('Bash')
    expect(explore).not.toContain('Write')
    expect(explore).not.toContain('Edit')
    expect(explore).not.toContain('Task')
    expect(explore).not.toContain('MultiTask')
  })

  it('appends the Explore restriction notice to the system prompt passed to the engine', async () => {
    ;(QueryEngine as any).mockImplementation(function (this: any, config: any) {
      capturedConfig = config
      this.submitMessage = async function* () {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'ok' }] },
        }
      }
    })

    await runSubagent(baseOpts({ mode: 'Explore' }))

    const prompt: string = capturedConfig.resolved.definition.prompt
    expect(prompt).toContain('You explore.')
    expect(prompt).toContain('Explore mode')
    expect(prompt).toContain('Do NOT modify')
  })
})

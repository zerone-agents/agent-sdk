import { describe, it, expect, beforeEach, vi } from 'vitest'
import type {
  ToolDefinition,
  AgentDefinition,
  RuntimeEnvironment,
  SDKSubagentMessage,
} from '../types.js'
import { createEmptyServices } from './services.js'

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
  // FindTool (eager) enables the lazy split so deferred catalog semantics are
  // exercisable; Skill keeps caps.skills alive through cross-validation (#72).
  { name: 'FindTool', isReadOnly: () => true, call: vi.fn() } as any,
  { name: 'Skill', isReadOnly: () => true, call: vi.fn() } as any,
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
  DEFAULT_SUBAGENT_MAX_TURNS,
} = await import('./spawn-subagent.js')

const runtime = {
  provider: {} as any,
  model: 'test-model',
  maxTokens: 4096,
  cwd: '/tmp',
  subprocessEnv: {},
  toolServices: createEmptyServices(),
} as RuntimeEnvironment

const AGENTS: Record<string, AgentDefinition> = {
  explorer: { description: 'Explores things', prompt: 'You explore.' },
}

let capturedConfig: any

function baseOpts(overrides: Partial<Parameters<typeof runSubagent>[0]> = {}) {
  return {
    runtime,
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

describe('spawn isolation (issue #72)', () => {
  const CHILD_A_MCP = {
    name: 'mcp__a__op', isReadOnly: () => true, call: vi.fn(),
    deferred: true, shortDescription: 'a op',
  } as any
  const CHILD_A_WRITE = { name: 'mcp__a__mutate', isReadOnly: () => false, call: vi.fn() } as any
  const CHILD_A_CUSTOM = { name: 'child_a_custom', isReadOnly: () => true, call: vi.fn() } as any
  const CHILD_A_WRITE_CUSTOM = { name: 'child_a_write_custom', isReadOnly: () => false, call: vi.fn() } as any
  const CHILD_A_SKILL = { name: 'child_a_skill', description: 'd', getPrompt: async () => [] } as any

  const ISO_AGENTS: Record<string, AgentDefinition> = {
    'child-a': {
      description: 'a', prompt: 'child-a prompt',
      capabilities: {
        connectionTools: [CHILD_A_MCP, CHILD_A_WRITE],
        customTools: [CHILD_A_CUSTOM, CHILD_A_WRITE_CUSTOM],
        skills: [CHILD_A_SKILL],
      },
    },
    'child-b': { description: 'b', prompt: 'child-b prompt' },
  }

  function captureEngine() {
    ;(QueryEngine as any).mockImplementation(function (this: any, config: any) {
      capturedConfig = config
      this.submitMessage = async function* () {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }
      }
    })
  }

  it('child-a resolves ONLY its own capabilities; deferred in own catalog; fresh findTool', async () => {
    captureEngine()
    await runSubagent(baseOpts({ agentName: 'child-a', subAgents: ISO_AGENTS }))
    const r = capturedConfig.resolved
    const names = [...r.tools, ...r.deferredTools].map((t: any) => t.name)
    // Own capability tools and nothing else beyond the shared built-ins
    // (order: eager pool first, then the deferred catalog)
    expect(names.filter((n: string) => n.startsWith('mcp__') || n.includes('_custom')))
      .toEqual(['child_a_custom', 'child_a_write_custom', 'mcp__a__mutate', 'mcp__a__op'])
    // Own deferred connection tool lands in the child's FindTool catalog
    expect(r.deferredTools.map((t: any) => t.name)).toEqual(['mcp__a__op'])
    // Skills isolated to the child's own set
    expect(r.skills.map((s: any) => s.name)).toEqual(['child_a_skill'])
    expect(r.skillRegistry.get('child_a_skill')).toBeDefined()
    // Fresh findTool registry per spawn — never the runtime's (parent's)
    expect(r.services.findTool).not.toBe(runtime.toolServices.findTool)
    expect(r.services.findTool.deferredTools).toEqual([])  // the engine seeds it at query start
    // Prompt contract: host-provided child prompt, no parent fallback
    expect(r.definition.prompt).toContain('child-a prompt')
    // Nesting ban
    expect(names).not.toContain('Task')
    expect(names).not.toContain('MultiTask')
  })

  it('child-b with no capabilities inherits nothing and does not fall back', async () => {
    captureEngine()
    await runSubagent(baseOpts({ agentName: 'child-b', subAgents: ISO_AGENTS }))
    const r = capturedConfig.resolved
    const names = [...r.tools, ...r.deferredTools].map((t: any) => t.name)
    expect(names.filter((n: string) => n.startsWith('mcp__') || n.includes('_custom'))).toEqual([])
    expect(r.skills).toEqual([])
    expect(r.deferredTools).toEqual([])
    expect(names).not.toContain('Task')
    expect(names).not.toContain('MultiTask')
  })

  it('Explore child-a keeps readOnly + Bash only; write MCP/Custom filtered from pool AND catalog', async () => {
    captureEngine()
    await runSubagent(baseOpts({ agentName: 'child-a', subAgents: ISO_AGENTS, mode: 'Explore' }))
    const r = capturedConfig.resolved
    const names = [...r.tools, ...r.deferredTools].map((t: any) => t.name)
    expect(names).toContain('Bash')
    expect(names).toContain('Read')
    expect(names).not.toContain('Write')
    expect(names).not.toContain('mcp__a__mutate')        // write MCP filtered
    expect(names).not.toContain('child_a_write_custom')  // write custom filtered
    expect(names).toContain('child_a_custom')            // read-only custom survives
    expect(names).toContain('mcp__a__op')                // read-only deferred stays discoverable
    expect(r.deferredTools.map((t: any) => t.name)).toEqual(['mcp__a__op'])
  })
})

// ---------------------------------------------------------------------------
// #78: diagnostics inheritance
// ---------------------------------------------------------------------------
describe('runSubagent diagnostics inheritance (#78)', () => {
  it('child engine inherits diagnostics via spawn opts (#78)', async () => {
    const events: unknown[] = []
    const sink = {
      debug: () => {}, trace: () => {},
      warn: () => events.push('warn'),
      error: () => events.push('error'),
      child: () => sink,
    }
    await runSubagent(baseOpts({ diagnostics: sink as any }))
    expect((capturedConfig as any)?.logger).toBe(sink)
  })
})

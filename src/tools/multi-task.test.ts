import { describe, it, expect, beforeEach, vi } from 'vitest'
import type {
  ToolDefinition,
  SubagentContext,
  AgentDefinition,
  AgentEnvironment,
} from '../types.js'
import { SkillRegistry } from '../skills/registry.js'

// Mock QueryEngine to avoid real LLM calls — must be a constructor (used with `new`)
vi.mock('../engine.js', () => ({
  QueryEngine: vi.fn().mockImplementation(function (this: any, config: any) {
    this.config = config
    this.submitMessage = async function* () {
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text: `Result for ${config.agentId}` }] },
      }
    }
  }),
}))

// Mock tools index to provide controlled tool set without circular dependency.
// resolveAgent walks getAllBaseTools + assembleToolPool + filterTools; spread the
// real implementations and only override getAllBaseTools so the tool pool is
// predictable but the rest of the resolution pipeline stays intact.
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

vi.mock('./index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./index.js')>()
  return {
    ...actual,
    getAllBaseTools: () => [...MOCK_TOOLS],
  }
})

const { QueryEngine } = await import('../engine.js')
const { MultiTaskTool } = await import('./multi-task.js')

const mockProvider = {
  apiType: 'anthropic-messages' as const,
  createMessage: vi.fn(),
}

const TEST_AGENTS: Record<string, AgentDefinition> = {
  general: {
    description: 'General agent',
    prompt: 'You are a general assistant.',
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
  },
  researcher: {
    description: 'Research agent',
    prompt: 'You are a research assistant.',
    allowedTools: ['Read', 'Glob', 'Grep', 'WebSearch'],
  },
}

function makeEnv(): AgentEnvironment {
  return {
    provider: mockProvider as any,
    model: 'claude-sonnet-4-6',
    maxTokens: 65536,
    cwd: '/tmp',
    customTools: [],
    mcpTools: [],
    skillRegistry: new SkillRegistry(),
  }
}

function makeContext(overrides: Partial<SubagentContext> = {}): SubagentContext {
  return {
    cwd: '/tmp',
    agentId: 'general',
    env: makeEnv(),
    subAgents: TEST_AGENTS,
    ...overrides,
  }
}

describe('MultiTaskTool', () => {
  beforeEach(async () => {
    vi.mocked(QueryEngine).mockReset()
    vi.mocked(QueryEngine).mockImplementation(function (this: any, config: any) {
      this.config = config
      this.submitMessage = async function* () {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: `Result for ${config.agentId}` }] },
        }
      }
    })
  })

  describe('parameter validation', () => {
    it('errors when tasks is empty', async () => {
      const result = await MultiTaskTool.call({ tasks: [] }, makeContext())
      expect(result.is_error).toBe(true)
      expect(result.content).toContain('tasks must be a non-empty array')
    })

    it('errors when tasks exceeds 10 items', async () => {
      const tasks = Array.from({ length: 11 }, (_, i) => ({
        description: `Task ${i}`,
        prompt: `Do task ${i}`,
        subagent_type: 'General',
      }))
      const result = await MultiTaskTool.call({ tasks }, makeContext())
      expect(result.is_error).toBe(true)
      expect(result.content).toContain('must not exceed 10 items')
    })

    it('errors when a task is missing prompt', async () => {
      const result = await MultiTaskTool.call({
        tasks: [{ description: 'No prompt', subagent_type: 'General' }],
      }, makeContext())
      expect(result.is_error).toBe(true)
      expect(result.content).toContain('missing prompt')
    })

    it('errors when a task is missing description', async () => {
      const result = await MultiTaskTool.call({
        tasks: [{ prompt: 'No description', subagent_type: 'General' }],
      }, makeContext())
      expect(result.is_error).toBe(true)
      expect(result.content).toContain('missing description')
    })

    it('errors when subagent_type is invalid', async () => {
      const result = await MultiTaskTool.call({
        tasks: [{ description: 'Bad type', prompt: 'test', subagent_type: 'Plan' }],
      }, makeContext())
      expect(result.is_error).toBe(true)
      expect(result.content).toContain("Must be either 'Explore' or 'General'")
    })
  })

  describe('happy path', () => {
    it('runs two simple subtasks in parallel and returns expected outputs', async () => {
      const result = await MultiTaskTool.call({
        tasks: [
          {
            description: 'Task one',
            prompt: 'Do task one',
            subagent_type: 'General',
            subagent_name: 'general',
          },
          {
            description: 'Task two',
            prompt: 'Do task two',
            subagent_type: 'General',
            subagent_name: 'researcher',
          },
        ],
      }, makeContext())

      expect(result.is_error).toBe(false)
      const content = result.content as string
      expect(content).toContain('Aggregated results across 2 completed subtask(s)')
      expect(content).toContain('## Task one')
      expect(content).toContain('Result for general')
      expect(content).toContain('## Task two')
      expect(content).toContain('Result for researcher')
      expect(content).not.toContain('Failed subtasks')
      expect(QueryEngine).toHaveBeenCalledTimes(2)
    })

    it('defaults subagent_type to General when omitted', async () => {
      const result = await MultiTaskTool.call({
        tasks: [
          {
            description: 'Default type task',
            prompt: 'Do something',
          },
        ],
      }, makeContext())

      expect(result.is_error).toBe(false)
      expect(result.content as string).toContain('Result for general')
      expect(QueryEngine).toHaveBeenCalledTimes(1)
      const config = vi.mocked(QueryEngine).mock.calls[0][0] as any
      expect(config.resolved.definition.prompt).not.toContain('Explore mode')
    })

    it('uses subagent_name when provided', async () => {
      await MultiTaskTool.call({
        tasks: [
          {
            description: 'Named agent task',
            prompt: 'Do something',
            subagent_type: 'General',
            subagent_name: 'researcher',
          },
        ],
      }, makeContext())

      const config = vi.mocked(QueryEngine).mock.calls[0][0] as any
      expect(config.agentId).toBe('researcher')
      expect(config.resolved.definition.prompt).toContain('research assistant')
    })

    it('falls back to parent agentId when subagent_name omitted', async () => {
      await MultiTaskTool.call({
        tasks: [
          {
            description: 'Fallback agent task',
            prompt: 'Do something',
            subagent_type: 'General',
          },
        ],
      }, makeContext({ agentId: 'general' }))

      const config = vi.mocked(QueryEngine).mock.calls[0][0] as any
      expect(config.agentId).toBe('general')
    })

    it('passes env.model to subagent engine', async () => {
      const env = makeEnv()
      env.model = 'gpt-4o'
      await MultiTaskTool.call({
        tasks: [
          {
            description: 'Parent model task',
            prompt: 'Do something',
            subagent_type: 'General',
          },
        ],
      }, makeContext({ env }))

      const config = vi.mocked(QueryEngine).mock.calls[0][0] as any
      expect(config.env.model).toBe('gpt-4o')
    })
  })

  describe('maxTurns handling (aligned with Task tool)', () => {
    it('defaults maxTurns to 10 when agentDef has no maxTurns', async () => {
      await MultiTaskTool.call({
        tasks: [
          { description: 'Default turns', prompt: 'x', subagent_type: 'General' },
        ],
      }, makeContext())

      const config = vi.mocked(QueryEngine).mock.calls[0][0] as any
      expect(config.maxTurns).toBe(10)
    })

    it('respects agentDef.maxTurns', async () => {
      const subAgents = {
        general: { ...TEST_AGENTS.general, maxTurns: 15 },
      }
      await MultiTaskTool.call({
        tasks: [
          { description: 'Agent turns', prompt: 'x', subagent_type: 'General' },
        ],
      }, makeContext({ subAgents }))

      const config = vi.mocked(QueryEngine).mock.calls[0][0] as any
      expect(config.maxTurns).toBe(15)
    })
  })

  describe('Explore mode', () => {
    it('restricts tools to read-only + Bash after allowedTools filter', async () => {
      await MultiTaskTool.call({
        tasks: [
          {
            description: 'Explore task',
            prompt: 'Explore code',
            subagent_type: 'Explore',
          },
        ],
      }, makeContext())

      const config = vi.mocked(QueryEngine).mock.calls[0][0] as any
      const toolNames = config.resolved.tools.map((t: any) => t.name)

      expect(toolNames).toContain('Read')
      expect(toolNames).toContain('Glob')
      expect(toolNames).toContain('Grep')
      expect(toolNames).toContain('Bash')
      expect(toolNames).not.toContain('Write')
      expect(toolNames).not.toContain('Edit')
      expect(toolNames).not.toContain('Task')
      expect(toolNames).not.toContain('MultiTask')
    })
  })

  describe('failure isolation', () => {
    it('marks a subtask failed when agent is not registered', async () => {
      const result = await MultiTaskTool.call({
        tasks: [
          {
            description: 'Good task',
            prompt: 'Do good task',
            subagent_type: 'General',
            subagent_name: 'general',
          },
          {
            description: 'Bad task',
            prompt: 'Do bad task',
            subagent_type: 'General',
            subagent_name: 'nonexistent',
          },
        ],
      }, makeContext())

      expect(result.is_error).toBe(false)
      const content = result.content as string
      expect(content).toContain('Aggregated results across 1 completed subtask(s)')
      expect(content).toContain('Failed subtasks')
      expect(content).toContain('not registered')
    })
  })

  describe('recursion prevention', () => {
    it('excludes Task and MultiTask tools in General mode', async () => {
      await MultiTaskTool.call({
        tasks: [
          {
            description: 'General task',
            prompt: 'Do something',
            subagent_type: 'General',
          },
        ],
      }, makeContext())

      const config = vi.mocked(QueryEngine).mock.calls[0][0] as any
      const toolNames = config.resolved.tools.map((t: any) => t.name)
      expect(toolNames).not.toContain('Task')
      expect(toolNames).not.toContain('MultiTask')
    })
  })

  describe('max turns handling', () => {
    it('marks is_error=true when max turns is hit (aligned with Task tool)', async () => {
      vi.mocked(QueryEngine).mockImplementation(function (this: any, config: any) {
        this.config = config
        this.submitMessage = async function* () {
          yield {
            type: 'result',
            subtype: 'error_max_turns',
          }
        }
      })

      const result = await MultiTaskTool.call({
        tasks: [
          {
            description: 'Max turns task',
            prompt: 'Do something',
            subagent_type: 'General',
            subagent_name: 'general',
          },
        ],
      }, makeContext())

      // Aligned with Task: maxTurnsHit → is_error: true (status stays 'completed',
      // output preserved with warning, but parent sees the error signal).
      expect(result.is_error).toBe(true)
      const content = result.content as string
      expect(content).toContain('max turns')
      expect(content).not.toContain('Failed subtasks')
    })
  })

  describe('silent completion detection', () => {
    it('marks failed when engine ends with error subtype (non-max-turns)', async () => {
      vi.mocked(QueryEngine).mockImplementation(function (this: any, config: any) {
        this.config = config
        this.submitMessage = async function* () {
          yield {
            type: 'result',
            subtype: 'error_during_execution',
          }
        }
      })

      const result = await MultiTaskTool.call({
        tasks: [
          { description: 'Engine error', prompt: 'x', subagent_type: 'General' },
        ],
      }, makeContext())

      const content = result.content as string
      expect(content).toContain('Failed subtasks')
      expect(content).toContain('error_during_execution')
    })

    it('marks failed when QueryEngine produces zero events', async () => {
      vi.mocked(QueryEngine).mockImplementation(function (this: any, config: any) {
        this.config = config
        this.submitMessage = async function* () {
          // yield nothing — simulates provider init failure / network error
        }
      })

      const result = await MultiTaskTool.call({
        tasks: [
          { description: 'No events', prompt: 'x', subagent_type: 'General' },
        ],
      }, makeContext())

      const content = result.content as string
      expect(content).toContain('Failed subtasks')
      expect(content).toContain('no events')
    })

    it('marks failed when subagent produces events but no text and no tool calls', async () => {
      vi.mocked(QueryEngine).mockImplementation(function (this: any, config: any) {
        this.config = config
        this.submitMessage = async function* () {
          yield { type: 'system', content: 'init' }
          yield { type: 'result', subtype: 'success' }
        }
      })

      const result = await MultiTaskTool.call({
        tasks: [
          { description: 'Silent completion', prompt: 'x', subagent_type: 'General' },
        ],
      }, makeContext())

      const content = result.content as string
      expect(content).toContain('Failed subtasks')
      expect(content).toContain('without producing any text or tool calls')
    })

    it('still marks completed when subagent produces text output', async () => {
      vi.mocked(QueryEngine).mockImplementation(function (this: any, config: any) {
        this.config = config
        this.submitMessage = async function* () {
          yield {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'Did the job' }] },
          }
          yield { type: 'result', subtype: 'success' }
        }
      })

      const result = await MultiTaskTool.call({
        tasks: [
          { description: 'Real work', prompt: 'x', subagent_type: 'General' },
        ],
      }, makeContext())

      const content = result.content as string
      expect(content).toContain('Did the job')
      expect(content).not.toContain('Failed subtasks')
    })

    it('still marks completed when subagent calls tools but produces no text', async () => {
      vi.mocked(QueryEngine).mockImplementation(function (this: any, config: any) {
        this.config = config
        this.submitMessage = async function* () {
          yield {
            type: 'assistant',
            message: { content: [{ type: 'tool_use', name: 'Read', id: '1', input: {} }] },
          }
          yield { type: 'result', subtype: 'success' }
        }
      })

      const result = await MultiTaskTool.call({
        tasks: [
          { description: 'Tool only', prompt: 'x', subagent_type: 'General' },
        ],
      }, makeContext())

      const content = result.content as string
      expect(content).toContain('(Subagent completed with no text output)')
      expect(content).not.toContain('Failed subtasks')
    })
  })

  describe('result text shape', () => {
    it('lists each completed subtask under its description heading in task order', async () => {
      const result = await MultiTaskTool.call({
        tasks: [
          { description: 'First task', prompt: 'a', subagent_type: 'General' },
          { description: 'Second task', prompt: 'b', subagent_type: 'General' },
          { description: 'Third task', prompt: 'c', subagent_type: 'General' },
        ],
      }, makeContext())

      const content = result.content as string
      const firstIdx = content.indexOf('## First task')
      const secondIdx = content.indexOf('## Second task')
      const thirdIdx = content.indexOf('## Third task')
      expect(firstIdx).toBeGreaterThanOrEqual(0)
      expect(secondIdx).toBeGreaterThan(firstIdx)
      expect(thirdIdx).toBeGreaterThan(secondIdx)
    })
  })

  describe('aggregation', () => {
    it('always includes summary containing each completed subtask description', async () => {
      const result = await MultiTaskTool.call({
        tasks: [
          { description: 'Alpha task', prompt: 'do a', subagent_type: 'General' },
          { description: 'Beta task', prompt: 'do b', subagent_type: 'General' },
        ],
      }, makeContext())

      const content = result.content as string
      expect(content).toContain('Aggregated results across 2 completed subtask(s)')
      expect(content).toContain('## Alpha task')
      expect(content).toContain('## Beta task')
    })

    it('reports failures without summary when all subtasks fail', async () => {
      vi.mocked(QueryEngine).mockImplementation(function (this: any) {
        this.submitMessage = async function* () {
          throw new Error('Boom')
        }
      })

      const result = await MultiTaskTool.call({
        tasks: [
          { description: 'Failing', prompt: 'x', subagent_type: 'General' },
        ],
      }, makeContext())

      const content = result.content as string
      expect(content).not.toContain('Aggregated results')
      expect(content).toContain('Failed subtasks')
      expect(content).toContain('Boom')
      expect(result.is_error).toBe(true)
    })
  })

  describe('toolUseId propagation', () => {
    it('emits subagent events with parent_tool_use_id matching context.toolUseId', async () => {
      const emittedEvents: any[] = []
      const context = makeContext({
        toolUseId: 'test-tool-use-id-123',
        emitEvent: (event: any) => emittedEvents.push(event),
      })

      await MultiTaskTool.call({
        tasks: [
          {
            description: 'ToolUseId task',
            prompt: 'Do something',
            subagent_type: 'General',
            subagent_name: 'general',
          },
        ],
      }, context)

      expect(emittedEvents.length).toBeGreaterThan(0)
      for (const event of emittedEvents) {
        expect(event.type).toBe('subagent')
        expect(event.parent_tool_use_id).toBe('test-tool-use-id-123')
      }
    })
  })

  describe('abort signal behavior', () => {
    it('marks subtask as aborted when abort signal is triggered', async () => {
      const controller = new AbortController()
      const emittedEvents: any[] = []

      vi.mocked(QueryEngine).mockImplementation(function (this: any, config: any) {
        this.config = config
        this.submitMessage = async function* () {
          yield {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'First chunk' }] },
          }
          yield {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'Second chunk' }] },
          }
          yield {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'Third chunk' }] },
          }
        }
      })

      const context = makeContext({
        abortSignal: controller.signal,
        emitEvent: (event: any) => {
          emittedEvents.push(event)
          if (emittedEvents.length === 1) {
            controller.abort()
          }
        },
      })

      const result = await MultiTaskTool.call({
        tasks: [
          {
            description: 'Abort task',
            prompt: 'Do something',
            subagent_type: 'General',
            subagent_name: 'general',
          },
        ],
      }, context)

      // Only the first stream event should have been emitted before abort;
      // the subtask_completed terminal event is emitted separately after the loop.
      const streamEvents = emittedEvents.filter((e: any) => e.event?.type !== 'subtask_completed')
      expect(streamEvents.length).toBe(1)
      expect(streamEvents[0].event.type).toBe('assistant')
      const completedEvents = emittedEvents.filter((e: any) => e.event?.type === 'subtask_completed')
      expect(completedEvents).toHaveLength(1)
      expect(completedEvents[0].event.status).toBe('aborted')

      // The subtask should be listed in the failure appendix with [aborted] suffix
      const content = result.content as string
      expect(content).toContain('Failed subtasks')
      expect(content).toContain('Abort task [aborted]')
      expect(content).toContain('aborted')
    })

    it('sets is_error=true when all subtasks are aborted', async () => {
      const controller = new AbortController()
      controller.abort()

      const context = makeContext({
        abortSignal: controller.signal,
      })

      const result = await MultiTaskTool.call({
        tasks: [
          { description: 'Task A', prompt: 'a', subagent_type: 'General' },
          { description: 'Task B', prompt: 'b', subagent_type: 'General' },
        ],
      }, context)

      expect(result.is_error).toBe(true)
      const content = result.content as string
      expect(content).toContain('Task A [aborted]')
      expect(content).toContain('Task B [aborted]')
    })
  })

  describe('subtask_completed emission', () => {
    it('emits subtask_completed for each successfully completed subtask', async () => {
      const emitEvent = vi.fn()
      await MultiTaskTool.call({
        tasks: [
          { description: 'Task one', prompt: 'do one', subagent_name: 'general' },
          { description: 'Task two', prompt: 'do two', subagent_name: 'researcher' },
        ],
      }, makeContext({ emitEvent }))

      // Sort by task_index for order-tolerant assertions: subtasks run via Promise.allSettled
      // with no ordering guarantee, so the captured events may arrive in any order.
      const completedEvents = emitEvent.mock.calls
        .map(([e]) => e)
        .filter((e: any) => e.type === 'subagent' && e.event?.type === 'subtask_completed')
        .sort((a: any, b: any) => a.task_index - b.task_index)

      expect(completedEvents).toHaveLength(2)
      expect(completedEvents[0].event.status).toBe('completed')
      expect(completedEvents[0].event.output).toBe('Result for general')
      expect(completedEvents[0].event.error).toBeNull()
      expect(completedEvents[0].event.toolsUsed).toEqual([])
      expect(completedEvents[0].event.maxTurnsHit).toBe(false)
      // Wrapper context
      expect(completedEvents[0].parent_tool_use_id).toBe('')
      expect(completedEvents[0].task_index).toBe(0)
      expect(completedEvents[0].task_description).toBe('Task one')
      expect(completedEvents[0].session_id).toBeTruthy()
      // Second subtask
      expect(completedEvents[1].task_index).toBe(1)
      expect(completedEvents[1].task_description).toBe('Task two')
    })

    it('does NOT emit subtask_completed on pre-spawn validation failure', async () => {
      const emitEvent = vi.fn()
      await MultiTaskTool.call({ tasks: [] }, makeContext({ emitEvent }))

      const completedEvents = emitEvent.mock.calls
        .map(([e]) => e)
        .filter((e: any) => e.type === 'subagent' && e.event?.type === 'subtask_completed')
      expect(completedEvents).toHaveLength(0)
    })

    it('does NOT emit when emitEvent is undefined', async () => {
      // Should not throw — uses optional chaining
      const result = await MultiTaskTool.call({
        tasks: [{ description: 'Task', prompt: 'do', subagent_name: 'general' }],
      }, makeContext({ emitEvent: undefined }))
      expect(result.is_error).toBe(false)
    })

    it('emits status=aborted when abortSignal fires before subtask starts', async () => {
      const ac = new AbortController()
      ac.abort()
      const emitEvent = vi.fn()
      await MultiTaskTool.call({
        tasks: [{ description: 'Aborted', prompt: 'do', subagent_name: 'general' }],
      }, makeContext({ emitEvent, abortSignal: ac.signal }))

      const completedEvents = emitEvent.mock.calls
        .map(([e]) => e)
        .filter((e: any) => e.type === 'subagent' && e.event?.type === 'subtask_completed')
      expect(completedEvents).toHaveLength(1)
      expect(completedEvents[0].event.status).toBe('aborted')
    })

    it('emits status=failed when inner engine produces zero events', async () => {
      vi.mocked(QueryEngine).mockImplementation(function (this: any, config: any) {
        this.config = config
        this.submitMessage = async function* () { /* yields nothing */ }
      })
      const emitEvent = vi.fn()
      await MultiTaskTool.call({
        tasks: [{ description: 'Silent', prompt: 'do', subagent_name: 'general' }],
      }, makeContext({ emitEvent }))

      const completedEvents = emitEvent.mock.calls
        .map(([e]) => e)
        .filter((e: any) => e.type === 'subagent' && e.event?.type === 'subtask_completed')
      expect(completedEvents).toHaveLength(1)
      expect(completedEvents[0].event.status).toBe('failed')
      expect(completedEvents[0].event.error).toMatch(/produced no events/)
    })

    it('emits status=completed with maxTurnsHit=true when inner engine hits max turns', async () => {
      vi.mocked(QueryEngine).mockImplementation(function (this: any, config: any) {
        this.config = config
        this.submitMessage = async function* () {
          yield { type: 'result', subtype: 'error_max_turns' } as any
        }
      })
      const emitEvent = vi.fn()
      await MultiTaskTool.call({
        tasks: [{ description: 'MaxTurns', prompt: 'do', subagent_name: 'general' }],
      }, makeContext({ emitEvent }))

      const completedEvents = emitEvent.mock.calls
        .map(([e]) => e)
        .filter((e: any) => e.type === 'subagent' && e.event?.type === 'subtask_completed')
      expect(completedEvents).toHaveLength(1)
      expect(completedEvents[0].event.status).toBe('completed')
      expect(completedEvents[0].event.maxTurnsHit).toBe(true)
    })

    it('emits status=failed when inner engine throws', async () => {
      vi.mocked(QueryEngine).mockImplementation(function (this: any, config: any) {
        this.config = config
        this.submitMessage = async function* () {
          throw new Error('provider exploded')
          yield // unreachable, satisfies generator type
        }
      })
      const emitEvent = vi.fn()
      await MultiTaskTool.call({
        tasks: [{ description: 'Throws', prompt: 'do', subagent_name: 'general' }],
      }, makeContext({ emitEvent }))

      const completedEvents = emitEvent.mock.calls
        .map(([e]) => e)
        .filter((e: any) => e.type === 'subagent' && e.event?.type === 'subtask_completed')
      expect(completedEvents).toHaveLength(1)
      expect(completedEvents[0].event.status).toBe('failed')
      expect(completedEvents[0].event.error).toMatch(/provider exploded/)
    })

    it('emits status=failed when inner engine ends with error_* subtype (non-max_turns)', async () => {
      vi.mocked(QueryEngine).mockImplementation(function (this: any, config: any) {
        this.config = config
        this.submitMessage = async function* () {
          yield { type: 'assistant', message: { content: [{ type: 'text', text: 'partial output' }] } }
          yield { type: 'result', subtype: 'error_during_execution' } as any
        }
      })
      const emitEvent = vi.fn()
      await MultiTaskTool.call({
        tasks: [{ description: 'Engine error', prompt: 'do', subagent_name: 'general' }],
      }, makeContext({ emitEvent }))

      const completedEvents = emitEvent.mock.calls
        .map(([e]) => e)
        .filter((e: any) => e.type === 'subagent' && e.event?.type === 'subtask_completed')
      expect(completedEvents).toHaveLength(1)
      expect(completedEvents[0].event.status).toBe('failed')
      expect(completedEvents[0].event.error).toMatch(/error_during_execution/)
    })

    it('emits status=failed on silent completion (events yielded but no text and no tool calls)', async () => {
      vi.mocked(QueryEngine).mockImplementation(function (this: any, config: any) {
        this.config = config
        this.submitMessage = async function* () {
          // Yield a system event but NO assistant content and NO tool calls
          yield { type: 'system', subtype: 'init', message: 'session started' } as any
          yield { type: 'result', subtype: 'success' } as any
        }
      })
      const emitEvent = vi.fn()
      await MultiTaskTool.call({
        tasks: [{ description: 'Silent', prompt: 'do', subagent_name: 'general' }],
      }, makeContext({ emitEvent }))

      const completedEvents = emitEvent.mock.calls
        .map(([e]) => e)
        .filter((e: any) => e.type === 'subagent' && e.event?.type === 'subtask_completed')
      expect(completedEvents).toHaveLength(1)
      expect(completedEvents[0].event.status).toBe('failed')
      expect(completedEvents[0].event.error).toMatch(/completed without producing any text/)
    })
  })
})

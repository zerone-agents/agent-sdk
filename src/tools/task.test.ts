import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type {
  ToolDefinition,
  SubagentContext,
  AgentDefinition,
  AgentEnvironment,
  RuntimeEnvironment,
} from '../types.js'
import { SkillRegistry } from '../skills/registry.js'
import { createEmptyServices } from './services.js'

// Mock QueryEngine to avoid real LLM calls — must be a constructor (used with `new`)
vi.mock('../engine.js', () => ({
  QueryEngine: vi.fn().mockImplementation(function (this: any, config: any) {
    this.config = config
    this.submitMessage = async function* () {
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Task completed' }] },
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
  { name: 'NotebookEdit', isReadOnly: () => false, call: vi.fn() } as any,
  { name: 'WebSearch', isReadOnly: () => true, call: vi.fn() } as any,
  { name: 'WebFetch', isReadOnly: () => true, call: vi.fn() } as any,
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
const { TaskTool } = await import('./task.js')

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
    subprocessEnv: {},
  }
}

function makeRuntime(): RuntimeEnvironment {
  return {
    provider: mockProvider as any,
    model: 'claude-sonnet-4-6',
    maxTokens: 65536,
    cwd: '/tmp',
    subprocessEnv: {},
    toolServices: createEmptyServices(),
  }
}

function makeContext(overrides: Partial<SubagentContext> = {}): SubagentContext {
  return {
    cwd: '/tmp',
    agentId: 'general',
    env: makeEnv(),
    runtime: makeRuntime(),
    subAgents: TEST_AGENTS,
    services: createEmptyServices(),
    subprocessEnv: {},
    ...overrides,
  }
}

describe('TaskTool', () => {
  let workdir: string

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'task-test-'))
    // Reset call history AND restore the default factory implementation, so
    // per-test mockImplementation overrides from prior tests don't leak
    // forward into unrelated tests.
    vi.mocked(QueryEngine).mockReset()
    vi.mocked(QueryEngine).mockImplementation(function (this: any, config: any) {
      this.config = config
      this.submitMessage = async function* () {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Task completed' }] },
        }
      }
    })
  })

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true })
  })

  describe('parameter validation', () => {
    it('errors when subagent_type is missing', async () => {
      const result = await TaskTool.call({
        prompt: 'test',
        description: 'test task',
      } as any, makeContext())

      expect(result.is_error).toBe(true)
      expect(result.content).toContain('subagent_type is required')
    })

    it('errors when subagent_type is invalid', async () => {
      const result = await TaskTool.call({
        prompt: 'test',
        description: 'test task',
        subagent_type: 'Plan',
      } as any, makeContext())

      expect(result.is_error).toBe(true)
      expect(result.content).toContain("Must be either 'Explore' or 'General'")
    })
  })

  describe('agent name resolution', () => {
    it('errors when agent is not in subAgents', async () => {
      const result = await TaskTool.call({
        prompt: 'test',
        description: 'test task',
        subagent_type: 'General',
        subagent_name: 'nonexistent',
      }, makeContext())

      expect(result.is_error).toBe(true)
      expect(result.content).toContain('not registered')
      expect(result.content).toContain('Available agents')
    })

    it('errors when agentId is not in subAgents', async () => {
      const result = await TaskTool.call({
        prompt: 'test',
        description: 'test task',
        subagent_type: 'General',
      }, makeContext({
        agentId: 'claude-code',
        subAgents: { researcher: TEST_AGENTS.researcher },
      }))

      expect(result.is_error).toBe(true)
      expect(result.content).toContain('claude-code')
      expect(result.content).toContain('Available agents: researcher')
    })

    it('uses subagent_name when provided', async () => {
      await TaskTool.call({
        prompt: 'test',
        description: 'test task',
        subagent_type: 'General',
        subagent_name: 'researcher',
      }, makeContext())

      expect(QueryEngine).toHaveBeenCalled()
      const config = vi.mocked(QueryEngine).mock.calls[0][0] as any
      expect(config.agentId).toBe('researcher')
      expect(config.resolved.definition.prompt).toContain('research assistant')
    })

    it('falls back to parent agentId when subagent_name omitted', async () => {
      await TaskTool.call({
        prompt: 'test',
        description: 'test task',
        subagent_type: 'General',
      }, makeContext({ agentId: 'general' }))

      const config = vi.mocked(QueryEngine).mock.calls[0][0] as any
      expect(config.agentId).toBe('general')
    })
  })

  describe('Explore mode', () => {
    it('restricts tools to read-only + Bash after allowedTools filter', async () => {
      await TaskTool.call({
        prompt: 'test',
        description: 'explore code',
        subagent_type: 'Explore',
      }, makeContext())

      const config = vi.mocked(QueryEngine).mock.calls[0][0] as any
      const toolNames = config.resolved.tools.map((t: any) => t.name)

      expect(toolNames).toContain('Read')
      expect(toolNames).toContain('Glob')
      expect(toolNames).toContain('Grep')
      expect(toolNames).toContain('Bash')
      expect(toolNames).not.toContain('Write')
      expect(toolNames).not.toContain('Edit')
      expect(toolNames).not.toContain('NotebookEdit')
      expect(toolNames).not.toContain('Task')
    })

    it('respects allowedTools whitelist before read-only filter', async () => {
      await TaskTool.call({
        prompt: 'test',
        description: 'explore code',
        subagent_type: 'Explore',
        subagent_name: 'researcher',
      }, makeContext())

      const config = vi.mocked(QueryEngine).mock.calls[0][0] as any
      const toolNames = config.resolved.tools.map((t: any) => t.name)

      expect(toolNames).toContain('Read')
      expect(toolNames).toContain('Glob')
      expect(toolNames).toContain('Grep')
      expect(toolNames).toContain('WebSearch')
      expect(toolNames).not.toContain('Bash')
      expect(toolNames).not.toContain('Task')
    })

    it('appends Explore restriction to system prompt', async () => {
      await TaskTool.call({
        prompt: 'test',
        description: 'explore code',
        subagent_type: 'Explore',
      }, makeContext())

      const config = vi.mocked(QueryEngine).mock.calls[0][0] as any
      expect(config.resolved.definition.prompt).toContain('Explore mode')
      expect(config.resolved.definition.prompt).toContain('Do NOT modify')
      expect(config.resolved.definition.prompt).toContain('general assistant')
    })
  })

  describe('General mode', () => {
    it('uses agent allowedTools', async () => {
      await TaskTool.call({
        prompt: 'test',
        description: 'general task',
        subagent_type: 'General',
        subagent_name: 'researcher',
      }, makeContext())

      const config = vi.mocked(QueryEngine).mock.calls[0][0] as any
      const toolNames = config.resolved.tools.map((t: any) => t.name)

      expect(toolNames).toContain('Read')
      expect(toolNames).toContain('WebSearch')
      expect(toolNames).not.toContain('Write')
      expect(toolNames).not.toContain('Edit')
      // Task and MultiTask must be excluded from subagent tool pool
      expect(toolNames).not.toContain('Task')
      expect(toolNames).not.toContain('MultiTask')
    })

    it('does not append Explore restriction', async () => {
      await TaskTool.call({
        prompt: 'test',
        description: 'general task',
        subagent_type: 'General',
      }, makeContext())

      const config = vi.mocked(QueryEngine).mock.calls[0][0] as any
      expect(config.resolved.definition.prompt).not.toContain('Explore mode')
    })

    it('does NOT include MultiTask in resolved tools', async () => {
      await TaskTool.call({
        prompt: 'test',
        description: 'general task',
        subagent_type: 'General',
      }, makeContext())

      const config = vi.mocked(QueryEngine).mock.calls[0][0] as any
      expect(config.resolved.tools.map((t: any) => t.name)).not.toContain('MultiTask')
    })
  })

  describe('env propagation', () => {
    it('passes env.model (not legacy flat model) to engine', async () => {
      const env = makeEnv()
      env.model = 'gpt-4o'
      await TaskTool.call({
        prompt: 'test',
        description: 'test task',
        subagent_type: 'General',
      }, makeContext({ env }))

      const config = vi.mocked(QueryEngine).mock.calls[0][0] as any
      expect(config.env.model).toBe('gpt-4o')
    })
  })

  describe('Task recursion prevention', () => {
    it('excludes Task tool in Explore mode', async () => {
      await TaskTool.call({
        prompt: 'test',
        description: 'explore',
        subagent_type: 'Explore',
      }, makeContext())

      const config = vi.mocked(QueryEngine).mock.calls[0][0] as any
      expect(config.resolved.tools.map((t: any) => t.name)).not.toContain('Task')
    })

    it('excludes Task tool in General mode', async () => {
      await TaskTool.call({
        prompt: 'test',
        description: 'general',
        subagent_type: 'General',
      }, makeContext())

      const config = vi.mocked(QueryEngine).mock.calls[0][0] as any
      expect(config.resolved.tools.map((t: any) => t.name)).not.toContain('Task')
    })
  })

  describe('no global state', () => {
    it('agents come from subAgents, not global registry', async () => {
      // Provide a unique agent only via subAgents
      const customAgent: AgentDefinition = {
        description: 'Custom',
        prompt: 'You are custom.',
        allowedTools: ['Read'],
      }

      await TaskTool.call({
        prompt: 'test',
        description: 'custom task',
        subagent_type: 'General',
        subagent_name: 'custom-agent',
      }, makeContext({
        subAgents: { 'custom-agent': customAgent },
        agentId: 'custom-agent',
      }))

      const config = vi.mocked(QueryEngine).mock.calls[0][0] as any
      expect(config.agentId).toBe('custom-agent')
      expect(config.resolved.definition.prompt).toContain('You are custom.')
    })
  })

  describe('subtask_completed emission', () => {
    it('emits subtask_completed on normal completion', async () => {
      const emitEvent = vi.fn()
      await TaskTool.call({
        description: 'Test task',
        prompt: 'do something',
        subagent_type: 'General',
        subagent_name: 'general',
      }, makeContext({ emitEvent, toolUseId: 'parent-tool-use-1' }))

      const completedEvents = emitEvent.mock.calls
        .map(([e]) => e)
        .filter((e: any) => e.type === 'subagent' && e.event?.type === 'subtask_completed')

      expect(completedEvents).toHaveLength(1)
      expect(completedEvents[0].event.status).toBe('completed')
      expect(completedEvents[0].event.output).toBe('Task completed')
      expect(completedEvents[0].event.error).toBeNull()
      expect(completedEvents[0].event.toolsUsed).toEqual([])
      // Wrapper context
      expect(completedEvents[0].parent_tool_use_id).toBe('parent-tool-use-1')
      expect(completedEvents[0].task_index).toBe(0)
      expect(completedEvents[0].task_description).toBe('Test task')
      expect(completedEvents[0].session_id).toBeTruthy()
    })

    it('does NOT emit subtask_completed on pre-spawn validation failure', async () => {
      const emitEvent = vi.fn()
      await TaskTool.call({
        description: 'Bad',
        prompt: 'do',
        subagent_type: 'InvalidMode',
      }, makeContext({ emitEvent }))

      const completedEvents = emitEvent.mock.calls
        .map(([e]) => e)
        .filter((e: any) => e.type === 'subagent' && e.event?.type === 'subtask_completed')
      expect(completedEvents).toHaveLength(0)
    })

    it('emits status=failed when inner engine throws', async () => {
      vi.mocked(QueryEngine).mockImplementation(function (this: any, config: any) {
        this.config = config
        this.submitMessage = async function* () {
          throw new Error('inner engine exploded')
          yield // unreachable
        }
      })
      const emitEvent = vi.fn()
      await TaskTool.call({
        description: 'Throws',
        prompt: 'do',
        subagent_type: 'General',
        subagent_name: 'general',
      }, makeContext({ emitEvent, toolUseId: 'parent-tool-use-2' }))

      const completedEvents = emitEvent.mock.calls
        .map(([e]) => e)
        .filter((e: any) => e.type === 'subagent' && e.event?.type === 'subtask_completed')
      expect(completedEvents).toHaveLength(1)
      expect(completedEvents[0].event.status).toBe('failed')
      expect(completedEvents[0].event.error).toMatch(/inner engine exploded/)
    })

    it('emits status=completed with maxTurnsHit=true on max_turns', async () => {
      vi.mocked(QueryEngine).mockImplementation(function (this: any, config: any) {
        this.config = config
        this.submitMessage = async function* () {
          yield { type: 'result', subtype: 'error_max_turns' } as any
        }
      })
      const emitEvent = vi.fn()
      await TaskTool.call({
        description: 'MaxTurns',
        prompt: 'do',
        subagent_type: 'General',
        subagent_name: 'general',
      }, makeContext({ emitEvent }))

      const completedEvents = emitEvent.mock.calls
        .map(([e]) => e)
        .filter((e: any) => e.type === 'subagent' && e.event?.type === 'subtask_completed')
      expect(completedEvents).toHaveLength(1)
      expect(completedEvents[0].event.status).toBe('completed')
      expect(completedEvents[0].event.maxTurnsHit).toBe(true)
    })

    it('does NOT emit when emitEvent is undefined', async () => {
      const result = await TaskTool.call({
        description: 'No emit',
        prompt: 'do',
        subagent_type: 'General',
        subagent_name: 'general',
      }, makeContext({ emitEvent: undefined }))
      expect(result.is_error).toBe(false)
    })

    it('regression: propagated inner-engine subagent events now carry parent_tool_use_id (was empty string)', async () => {
      const emitEvent = vi.fn()
      await TaskTool.call({
        description: 'Regression',
        prompt: 'do',
        subagent_type: 'General',
        subagent_name: 'general',
      }, makeContext({ emitEvent, toolUseId: 'parent-tool-use-regression' }))

      // Look at ALL subagent events, not just subtask_completed
      const subagentEvents = emitEvent.mock.calls
        .map(([e]) => e)
        .filter((e: any) => e.type === 'subagent')

      // At least one assistant event should have propagated with correct ID
      const assistantEvents = subagentEvents.filter((e: any) => e.event?.type === 'assistant')
      expect(assistantEvents.length).toBeGreaterThan(0)
      for (const e of assistantEvents) {
        expect(e.parent_tool_use_id).toBe('parent-tool-use-regression')
        expect(e.task_index).toBe(0)
        expect(e.task_description).toBe('Regression')
      }
    })
  })
})

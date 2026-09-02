import { describe, it, expect, vi } from 'vitest'

const MOCK_TOOLS = [
  { name: 'Read', isReadOnly: () => true, call: vi.fn() },
  { name: 'Write', isReadOnly: () => false, call: vi.fn() },
  { name: 'Bash', isReadOnly: () => false, call: vi.fn() },
  { name: 'Task', isReadOnly: () => false, call: vi.fn() },
  { name: 'MultiTask', isReadOnly: () => false, call: vi.fn() },
  { name: 'Skill', isReadOnly: () => true, call: vi.fn() },
  { name: 'FindTool', isReadOnly: () => true, call: vi.fn() },
  { name: 'CronList', isReadOnly: () => true, call: vi.fn(), deferred: true, shortDescription: 'List scheduled tasks' },
] as any[]

vi.mock('./tools/index.js', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return {
    ...actual,
    getAllBaseTools: () => [...MOCK_TOOLS],
  }
})

import { resolveAgent, resolveAgentCapabilities } from './resolve-agent.js'
import { resolvePrompt } from './prompts/system-prompts.js'
import { SkillRegistry } from './skills/registry.js'
import type { AgentEnvironment, AgentCapabilities, RuntimeEnvironment } from './types.js'

function makeEnv(overrides: Partial<AgentEnvironment> = {}): AgentEnvironment {
  const skillRegistry = new SkillRegistry()
  skillRegistry.register({
    name: 'commit', description: 'd', getPrompt: async () => [],
  })
  return {
    provider: { apiType: 'anthropic-messages', createMessage: vi.fn() } as any,
    model: 'test-model',
    maxTokens: 1000,
    cwd: '/tmp',
    customTools: [],
    mcpTools: [],
    skillRegistry,
    subprocessEnv: {},
    ...overrides,
  }
}

describe('resolveAgent', () => {
  it('returns full builtin pool when no allow/deny lists', () => {
    const r = resolveAgent(makeEnv(), { description: 'd', prompt: 'p' })
    expect(r.tools.map(t => t.name)).toEqual(['Read', 'Write', 'Bash', 'Task', 'MultiTask', 'Skill', 'FindTool'])
  })

  it('applies allowedTools then disallowedTools (deny wins)', () => {
    const r = resolveAgent(makeEnv(), {
      description: 'd', prompt: 'p',
      allowedTools: ['Read', 'Write', 'Bash'],
      disallowedTools: ['Bash'],
    })
    expect(r.tools.map(t => t.name)).toEqual(['Read', 'Write'])
  })

  it('merges customTools and mcpTools into the pool with dedupe by name', () => {
    const custom = { name: 'MyTool', isReadOnly: () => true, call: vi.fn() } as any
    const mcp = { name: 'Read', description: 'mcp override', isReadOnly: () => true, call: vi.fn() } as any
    const r = resolveAgent(makeEnv({ customTools: [custom], mcpTools: [mcp] }), { description: 'd', prompt: 'p' })
    const names = r.tools.map(t => t.name)
    expect(names).toContain('MyTool')
    expect(names.filter(n => n === 'Read')).toHaveLength(1)
    expect(r.tools.find(t => t.name === 'Read')?.description).toBe('mcp override')
  })

  it('filters skills by availableSkills', () => {
    const env = makeEnv()
    env.skillRegistry.register(
      { name: 'review', description: 'd', getPrompt: async () => [] },
    )
    const r = resolveAgent(env, { description: 'd', prompt: 'p', availableSkills: ['commit'] })
    expect(r.skills.map(s => s.name)).toEqual(['commit'])
  })

  it('drops skills when Skill tool is filtered out via allowedTools', () => {
    const env = makeEnv()  // 'commit' skill is registered by makeEnv
    const r = resolveAgent(env, {
      description: 'd', prompt: 'p',
      allowedTools: ['Read'],  // Skill not listed
    })
    expect(r.tools.map(t => t.name)).toEqual(['Read'])
    expect(r.skills).toEqual([])
  })

  it('drops skills when Skill tool is excluded via disallowedTools', () => {
    const env = makeEnv()
    const r = resolveAgent(env, {
      description: 'd', prompt: 'p',
      disallowedTools: ['Skill'],
    })
    expect(r.tools.map(t => t.name)).not.toContain('Skill')
    expect(r.skills).toEqual([])
  })

  it('preserves skills when Skill tool is in allowedTools (regression)', () => {
    const env = makeEnv()
    const r = resolveAgent(env, {
      description: 'd', prompt: 'p',
      allowedTools: ['Read', 'Skill'],
    })
    expect(r.tools.map(t => t.name)).toEqual(['Read', 'Skill'])
    expect(r.skills.map(s => s.name)).toEqual(['commit'])
  })

  it('splits deferred tools from eager when FindTool is available', () => {
    const env = makeEnv()
    const r = resolveAgent(env, { description: 'd', prompt: 'p' })
    // MOCK_TOOLS has 8 entries: 7 eager + 1 deferred (CronList)
    expect(r.tools.map(t => t.name)).toEqual(
      ['Read', 'Write', 'Bash', 'Task', 'MultiTask', 'Skill', 'FindTool'],
    )
    expect(r.deferredTools.map(t => t.name)).toEqual(['CronList'])
  })

  it('preserves shortDescription on deferred tools', () => {
    const env = makeEnv()
    const r = resolveAgent(env, { description: 'd', prompt: 'p' })
    expect(r.deferredTools[0].shortDescription).toBe('List scheduled tasks')
  })

  it('disables lazy-loading when disallowedTools excludes FindTool', () => {
    const env = makeEnv()
    const r = resolveAgent(env, {
      description: 'd', prompt: 'p',
      disallowedTools: ['FindTool'],
    })
    // Fallback: ALL filtered tools (including CronList) go to eager
    expect(r.tools.map(t => t.name)).toContain('CronList')
    expect(r.tools.map(t => t.name)).not.toContain('FindTool')
    expect(r.deferredTools).toEqual([])
  })

  it('disables lazy-loading when allowedTools omits FindTool', () => {
    const env = makeEnv()
    const r = resolveAgent(env, {
      description: 'd', prompt: 'p',
      allowedTools: ['Read', 'Write', 'CronList'],
    })
    // FindTool not in allow-list → lazy-loading disabled → CronList forced eager
    expect(r.tools.map(t => t.name)).toEqual(['Read', 'Write', 'CronList'])
    expect(r.deferredTools).toEqual([])
  })

  it('enables lazy-loading when allowedTools includes FindTool', () => {
    const env = makeEnv()
    const r = resolveAgent(env, {
      description: 'd', prompt: 'p',
      allowedTools: ['Read', 'FindTool', 'CronList'],
    })
    expect(r.tools.map(t => t.name)).toEqual(['Read', 'FindTool'])
    expect(r.deferredTools.map(t => t.name)).toEqual(['CronList'])
  })
})

describe('resolveAgent source-based filtering contract (issue #64 review)', () => {
  const mcpA = { name: 'mcp__srv__alpha', isReadOnly: () => true, call: vi.fn() } as any
  const mcpB = { name: 'mcp__srv__beta', isReadOnly: () => true, call: vi.fn() } as any
  const custom = { name: 'my_custom', isReadOnly: () => false, call: vi.fn() } as any

  it('MCP tools bypass allowedTools (allow-list gates built-ins only)', () => {
    const r = resolveAgent(
      makeEnv({ mcpTools: [mcpA, mcpB] }),
      { description: 'd', prompt: 'p', allowedTools: ['Read'] },
    )
    const names = r.tools.map(t => t.name)
    expect(names).toContain('Read')
    expect(names).toContain('mcp__srv__alpha')
    expect(names).toContain('mcp__srv__beta')
    // unlisted built-ins are still gated
    expect(names).not.toContain('Write')
    expect(names).not.toContain('Bash')
  })

  it('custom tools bypass allowedTools', () => {
    const r = resolveAgent(
      makeEnv({ customTools: [custom] }),
      { description: 'd', prompt: 'p', allowedTools: ['Read'] },
    )
    const names = r.tools.map(t => t.name)
    expect(names).toContain('my_custom')
    expect(names).toContain('Read')
    expect(names).not.toContain('Write')
  })

  it('disallowedTools still applies to MCP tools (deny runs on the merged pool)', () => {
    const r = resolveAgent(
      makeEnv({ mcpTools: [mcpA, mcpB] }),
      {
        description: 'd',
        prompt: 'p',
        allowedTools: ['Read'],
        disallowedTools: ['mcp__srv__beta'],
      },
    )
    const names = r.tools.map(t => t.name)
    expect(names).toContain('mcp__srv__alpha')
    expect(names).not.toContain('mcp__srv__beta')
  })

  it('deny-list wildcard removes MCP tools while unlisted base tools survive', () => {
    const r = resolveAgent(
      makeEnv({ mcpTools: [mcpA, mcpB] }),
      { description: 'd', prompt: 'p', disallowedTools: ['mcp__srv__*'] },
    )
    const names = r.tools.map(t => t.name)
    expect(names).toContain('Read')
    expect(names).not.toContain('mcp__srv__alpha')
    expect(names).not.toContain('mcp__srv__beta')
  })

  it('warns when the final pool resolves to zero tools', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const r = resolveAgent(
        makeEnv(),
        { description: 'd', prompt: 'p', allowedTools: ['DoesNotExist'] },
      )
      expect(r.tools).toEqual([])
      const warns = warn.mock.calls.map(c => String(c[0]))
      // scope warning from applyAllowedTools + final-pool warning from resolveAgent
      expect(warns.some(w => w.includes('matched none of the 8 built-in tools'))).toBe(true)
      expect(warns.some(w => w.includes('resolved to zero tools'))).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })
})

describe('resolvePrompt', () => {
  it('returns undefined for undefined/empty', () => {
    expect(resolvePrompt(undefined)).toBeUndefined()
    expect(resolvePrompt('')).toBeUndefined()
  })
  it('passes through plain strings', () => {
    expect(resolvePrompt('hello')).toBe('hello')
  })
  it('resolves presets and append', () => {
    expect(resolvePrompt({ type: 'preset', preset: 'default' })).toContain('helpful assistant')
    expect(resolvePrompt({ type: 'preset', preset: 'default', append: 'EXTRA' })).toContain('EXTRA')
  })
})

describe('per-agent seam (issue #72)', () => {
  it('carries env.toolServices by reference and defaults to empty services', () => {
    const services = {
      askUser: null,
      findTool: { deferredTools: [], activatedTools: new Set() },
      config: new Map(),
      cron: null,
    } as any
    const withServices = resolveAgent(
      makeEnv({ toolServices: services }),
      { description: 'd', prompt: 'p' },
    )
    expect(withServices.services).toBe(services)

    const without = resolveAgent(makeEnv(), { description: 'd', prompt: 'p' })
    expect(without.services.findTool.deferredTools).toEqual([])
  })

  it('carries env.skillRegistry by reference', () => {
    const env = makeEnv()
    const r = resolveAgent(env, { description: 'd', prompt: 'p' })
    expect(r.skillRegistry).toBe(env.skillRegistry)
  })
})

function makeRuntime(overrides: Partial<RuntimeEnvironment> = {}): RuntimeEnvironment {
  return {
    provider: { apiType: 'anthropic-messages', createMessage: vi.fn() } as any,
    model: 'test-model',
    maxTokens: 1000,
    cwd: '/tmp',
    subprocessEnv: {},
    toolServices: {
      askUser: null,
      findTool: { deferredTools: [], activatedTools: new Set() },
      config: new Map(),
      cron: null,
    },
    ...overrides,
  }
}

describe('resolveAgentCapabilities (v3 pipeline, issue #72)', () => {
  const def = { description: 'd', prompt: 'p' }

  it('merges caps pools with base tools; custom/connection bypass allow-list', () => {
    const custom = { name: 'C1', isReadOnly: () => true, call: vi.fn() } as any
    const conn = { name: 'mcp__x__y', isReadOnly: () => false, call: vi.fn() } as any
    const r = resolveAgentCapabilities(
      makeRuntime(),
      { customTools: [custom], connectionTools: [conn], allowedTools: ['Read'] },
      def,
    )
    const names = r.tools.map(t => t.name)
    expect(names).toContain('Read')
    expect(names).not.toContain('Bash')        // allow-list gates built-ins
    expect(names).toContain('C1')              // custom bypasses allow-list
    expect(names).toContain('mcp__x__y')       // connection bypasses allow-list
  })

  it('spawn removes Task/MultiTask after allow/deny', () => {
    const r = resolveAgentCapabilities(makeRuntime(), {}, def, { spawn: { mode: 'General' } })
    const names = r.tools.map(t => t.name)
    expect(names).not.toContain('Task')
    expect(names).not.toContain('MultiTask')
  })

  it('Explore keeps only readOnly tools + Bash, write tools undiscoverable in deferred catalog', () => {
    const roDeferred = { name: 'mcp__ro__peek', isReadOnly: () => true, deferred: true, shortDescription: 's', call: vi.fn() } as any
    const wrDeferred = { name: 'mcp__wr__mutate', isReadOnly: () => false, deferred: true, shortDescription: 's', call: vi.fn() } as any
    const r = resolveAgentCapabilities(
      makeRuntime(),
      { connectionTools: [roDeferred, wrDeferred] },
      def,
      { spawn: { mode: 'Explore' } },
    )
    expect(r.tools.some(t => t.name === 'Bash')).toBe(true)
    expect(r.tools.some(t => t.name === 'Write')).toBe(false)
    const deferredNames = r.deferredTools.map(t => t.name)
    expect(deferredNames).toContain('mcp__ro__peek')
    expect(deferredNames).not.toContain('mcp__wr__mutate')
  })

  it('spawn builds fresh SkillRegistry from caps.skills; no skills without caps', () => {
    const skill = { name: 's1', description: 'd', getPrompt: async () => [] } as any
    const r = resolveAgentCapabilities(
      makeRuntime(), { skills: [skill] }, def, { spawn: { mode: 'General' } },
    )
    expect(r.skills.map(s => s.name)).toEqual(['s1'])
    expect(r.skillRegistry.get('s1')).toBeDefined()
    const empty = resolveAgentCapabilities(makeRuntime(), {}, def, { spawn: { mode: 'General' } })
    expect(empty.skills).toEqual([])
  })

  it('root uses opts.skillRegistry and caps.skills verbatim', () => {
    const reg = new SkillRegistry()
    const r = resolveAgentCapabilities(makeRuntime(), { skills: [] }, def, { skillRegistry: reg })
    expect(r.skillRegistry).toBe(reg)
  })

  it('uses runtime.toolServices as resolved.services', () => {
    const rt = makeRuntime()
    const r = resolveAgentCapabilities(rt, {}, def)
    expect(r.services).toBe(rt.toolServices)
  })
})

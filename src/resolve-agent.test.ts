import { describe, it, expect, vi } from 'vitest'

const MOCK_TOOLS = [
  { name: 'Read', isReadOnly: () => true, call: vi.fn() },
  { name: 'Write', isReadOnly: () => false, call: vi.fn() },
  { name: 'Bash', isReadOnly: () => false, call: vi.fn() },
  { name: 'Task', isReadOnly: () => false, call: vi.fn() },
  { name: 'MultiTask', isReadOnly: () => false, call: vi.fn() },
] as any[]

vi.mock('./tools/index.js', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return {
    ...actual,
    getAllBaseTools: () => [...MOCK_TOOLS],
  }
})

import { resolveAgent } from './resolve-agent.js'
import { resolvePrompt } from './prompts/system-prompts.js'
import { SkillRegistry } from './skills/registry.js'
import type { AgentEnvironment } from './types.js'

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
    ...overrides,
  }
}

describe('resolveAgent', () => {
  it('returns full builtin pool when no allow/deny lists', () => {
    const r = resolveAgent(makeEnv(), { description: 'd', prompt: 'p' })
    expect(r.tools.map(t => t.name)).toEqual(['Read', 'Write', 'Bash', 'Task', 'MultiTask'])
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

  it('filters skills by allowedSkills', () => {
    const env = makeEnv()
    env.skillRegistry.register(
      { name: 'review', description: 'd', getPrompt: async () => [] },
    )
    const r = resolveAgent(env, { description: 'd', prompt: 'p', allowedSkills: ['commit'] })
    expect(r.skills.map(s => s.name)).toEqual(['commit'])
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

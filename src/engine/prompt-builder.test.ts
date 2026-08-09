import { describe, it, expect } from 'vitest'
import { buildSystemPrompt, buildEnvironmentPrompt } from './prompt-builder.js'
import type { QueryEngineConfig } from '../types.js'

function makeConfig(overrides: Partial<QueryEngineConfig> = {}): QueryEngineConfig {
  return {
    env: {
      cwd: '/test',
      model: 'test-model',
      provider: {} as any,
      tools: [],
      skills: [],
      settingSources: [],
    },
    resolved: {
      definition: { prompt: 'You are a test agent', allowedTools: [], availableSkills: [] },
      tools: [],
      deferredTools: [],
      skills: [],
    },
    subAgents: {},
    ...overrides,
  } as any
}

describe('buildSystemPrompt', () => {
  it('includes agent base prompt', async () => {
    const config = makeConfig()
    const prompt = await buildSystemPrompt(config)
    expect(prompt).toContain('You are a test agent')
  })

  it('includes appendPrompt when provided', async () => {
    const config = makeConfig({
      resolved: {
        definition: { prompt: 'Base', appendPrompt: 'Extra instructions', allowedTools: [], availableSkills: [] },
        tools: [],
        deferredTools: [],
        skills: [],
      },
    } as any)
    const prompt = await buildSystemPrompt(config)
    expect(prompt).toContain('Extra instructions')
  })
})

describe('buildEnvironmentPrompt', () => {
  it('returns a non-empty string', async () => {
    const config = makeConfig()
    const envPrompt = await buildEnvironmentPrompt(config)
    expect(typeof envPrompt).toBe('string')
  })

  it('omits Skills section when resolved.skills is empty (matches post-resolveAgent state)', async () => {
    // Simulate what resolveAgent produces when Skill tool is filtered out:
    // tools has no Skill, skills is []. prompt-builder should not inject the
    // Skills section.
    const config = makeConfig({
      resolved: {
        definition: { prompt: 'Base', allowedTools: [], availableSkills: [] },
        tools: [{ name: 'Read', call: () => Promise.resolve({}) } as any],
        deferredTools: [],
        skills: [],  // resolveAgent already zeroed this
      },
    } as any)
    const envPrompt = await buildEnvironmentPrompt(config)
    expect(envPrompt).not.toContain('## Skills')
    expect(envPrompt).not.toContain('<available_skills>')
  })

  it('includes <sources> block when settingSources is non-empty', async () => {
    const config = makeConfig({
      env: {
        cwd: '/test/project',
        model: 'test-model',
        provider: {} as any,
        tools: [],
        skills: [],
        settingSources: ['user', 'project'],
      },
      resolved: {
        definition: { prompt: 'Base', allowedTools: [], availableSkills: [] },
        tools: [{ name: 'Skill', call: () => Promise.resolve({}) } as any],
        deferredTools: [],
        skills: [
          { name: 'demo', description: 'desc', getPrompt: async () => [] } as any,
        ],
      },
    } as any)
    const envPrompt = await buildEnvironmentPrompt(config)
    expect(envPrompt).toContain('<sources>')
    expect(envPrompt).toContain('user: ~/.agents/skills')
    expect(envPrompt).toContain('project: /test/project/.agents/skills')
  })

  it('injects <available_deferred_tools> catalog when deferredTools non-empty', async () => {
    const config = makeConfig({
      resolved: {
        definition: { prompt: 'Base', allowedTools: [], availableSkills: [] },
        tools: [{ name: 'ToolSearch', call: () => Promise.resolve({}) } as any],
        deferredTools: [
          {
            name: 'CronList',
            description: 'long description that would be expensive to inject',
            shortDescription: 'List scheduled tasks',
            call: () => Promise.resolve({}),
          } as any,
        ],
        skills: [],
      },
    } as any)
    const envPrompt = await buildEnvironmentPrompt(config)
    expect(envPrompt).toContain('<available_deferred_tools>')
    expect(envPrompt).toContain('CronList: List scheduled tasks')
    expect(envPrompt).toContain('</available_deferred_tools>')
    // The catalog uses shortDescription, not the long description
    expect(envPrompt).not.toContain('long description that would be expensive')
  })

  it('catalog falls back to description when shortDescription absent', async () => {
    const config = makeConfig({
      resolved: {
        definition: { prompt: 'Base', allowedTools: [], availableSkills: [] },
        tools: [{ name: 'ToolSearch', call: () => Promise.resolve({}) } as any],
        deferredTools: [
          {
            name: 'Mystery',
            description: 'Fallback description under 200 chars',
            call: () => Promise.resolve({}),
            // shortDescription intentionally absent
          } as any,
        ],
        skills: [],
      },
    } as any)
    const envPrompt = await buildEnvironmentPrompt(config)
    expect(envPrompt).toContain('Mystery: Fallback description under 200 chars')
  })
})

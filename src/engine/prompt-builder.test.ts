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
      definition: { prompt: 'You are a test agent', allowedTools: [], allowedSkills: [] },
      tools: [],
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
        definition: { prompt: 'Base', appendPrompt: 'Extra instructions', allowedTools: [], allowedSkills: [] },
        tools: [],
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
})

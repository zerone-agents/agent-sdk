import { describe, it, expect } from 'vitest'
import { SkillTool } from './skill.js'
import { SkillRegistry } from '../skills/registry.js'
import type { SkillContext } from '../types.js'

function makeCtx(overrides: Partial<SkillContext> = {}): SkillContext {
  return {
    toolUseId: 'tu_1',
    resolvedSkills: [],
    skillRegistry: new SkillRegistry(),
    ...overrides,
  } as SkillContext
}

describe('SkillTool — error message for unknown skill', () => {
  it('lists registry contents (getUserInvocable), not resolvedSkills', async () => {
    // Registry holds A and B; resolvedSkills (allowlist) only contains A.
    // After the allowlist-relaxation fix, runtime can load ANY registered
    // skill, so the "unknown skill" error must surface everything actually
    // available in the registry — otherwise the model is misled into
    // thinking B cannot be invoked.
    const registry = new SkillRegistry()
    registry.register({ name: 'alpha', description: 'a', getPrompt: async () => [] })
    registry.register({ name: 'beta', description: 'b', getPrompt: async () => [] })

    const ctx = makeCtx({
      skillRegistry: registry,
      resolvedSkills: [
        { name: 'alpha', description: 'a', getPrompt: async () => [] },
      ] as any,
    })

    const result: any = await SkillTool.call({ skill: 'does-not-exist' }, ctx)
    expect(result.is_error).toBe(true)
    expect(result.content).toContain('alpha')
    expect(result.content).toContain('beta')
  })
})

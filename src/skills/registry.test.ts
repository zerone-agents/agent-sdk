import { describe, it, expect } from 'vitest'
import { SkillRegistry, filterSkillsByAllowlist } from './registry.js'
import type { SkillDefinition } from './types.js'

function makeSkill(name: string, extra: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    name,
    description: `${name} desc`,
    getPrompt: async () => [{ type: 'text', text: name }],
    ...extra,
  }
}

describe('SkillRegistry base + overlay', () => {
  it('resolves own skills before base', () => {
    const base = new SkillRegistry()
    base.register(makeSkill('commit', { description: 'base version' }))
    const overlay = new SkillRegistry(base)
    overlay.register(makeSkill('commit', { description: 'overlay version' }), 'project')
    expect(overlay.get('commit')?.description).toBe('overlay version')
  })

  it('falls back to base for missing skills', () => {
    const base = new SkillRegistry()
    base.register(makeSkill('review'))
    const overlay = new SkillRegistry(base)
    expect(overlay.get('review')?.name).toBe('review')
  })

  it('getAll merges base and own, own wins on name conflict', () => {
    const base = new SkillRegistry()
    base.register(makeSkill('a'))
    base.register(makeSkill('b', { description: 'base b' }))
    const overlay = new SkillRegistry(base)
    overlay.register(makeSkill('b', { description: 'own b' }), 'user')
    overlay.register(makeSkill('c'), 'project')
    const all = overlay.getAll()
    expect(all.map(s => s.name).sort()).toEqual(['a', 'b', 'c'])
    expect(all.find(s => s.name === 'b')?.description).toBe('own b')
  })

  it('resolves aliases through the chain', () => {
    const base = new SkillRegistry()
    base.register(makeSkill('commit', { aliases: ['ci'] }))
    const overlay = new SkillRegistry(base)
    expect(overlay.get('ci')?.name).toBe('commit')
  })

  it('clearFilesystem removes only user/project sources, keeps programmatic', () => {
    const reg = new SkillRegistry()
    reg.register(makeSkill('prog')) // default source: programmatic
    reg.register(makeSkill('u'), 'user')
    reg.register(makeSkill('p', { aliases: ['pp'] }), 'project')
    reg.clearFilesystem()
    expect(reg.has('prog')).toBe(true)
    expect(reg.has('u')).toBe(false)
    expect(reg.has('p')).toBe(false)
    expect(reg.has('pp')).toBe(false)
  })

  it('clearFilesystem on overlay does not touch base', () => {
    const base = new SkillRegistry()
    base.register(makeSkill('base-skill'), 'user')
    const overlay = new SkillRegistry(base)
    overlay.register(makeSkill('own-skill'), 'project')
    overlay.clearFilesystem()
    expect(overlay.has('base-skill')).toBe(true)
    expect(overlay.has('own-skill')).toBe(false)
  })

  it('tags registered skills with source', () => {
    const reg = new SkillRegistry()
    reg.register(makeSkill('x'), 'project')
    expect(reg.get('x')?.source).toBe('project')
    reg.register(makeSkill('y'))
    expect(reg.get('y')?.source).toBe('programmatic')
  })
})

describe('filterSkillsByAllowlist', () => {
  it('returns all when allowlist is undefined or empty', () => {
    const skills = [makeSkill('a'), makeSkill('b')]
    expect(filterSkillsByAllowlist(skills, undefined)).toHaveLength(2)
    expect(filterSkillsByAllowlist(skills, [])).toHaveLength(2)
  })

  it('allows project-sourced skills regardless of allowlist', () => {
    const skills = [
      makeSkill('prog'),
      { ...makeSkill('proj'), source: 'project' as const },
    ]
    const filtered = filterSkillsByAllowlist(skills, ['other'])
    expect(filtered.map(s => s.name)).toEqual(['proj'])
  })

  it('filters non-project skills by allowlist', () => {
    const skills = [makeSkill('a'), makeSkill('b')]
    expect(filterSkillsByAllowlist(skills, ['a']).map(s => s.name)).toEqual(['a'])
  })
})

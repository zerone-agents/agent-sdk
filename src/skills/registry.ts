/**
 * Skill Registry
 *
 * Two-layer design: a module-level defaultRegistry holds programmatically
 * registered skills (globally shared). Each Agent creates its own
 * SkillRegistry with defaultRegistry as base; filesystem-loaded skills go
 * into the agent's own overlay. Lookups walk own -> base.
 */

import type { SkillDefinition } from './types.js'
import type { SkillSource, SettingSource } from '../types.js'
import { SYSTEM_PROMPTS } from '../prompts/system-prompts.js'

export class SkillRegistry {
  private own = new Map<string, SkillDefinition>()
  private ownAliases = new Map<string, string>()

  constructor(private base?: SkillRegistry) {}

  register(definition: SkillDefinition, source: SkillSource = 'programmatic'): void {
    this.own.set(definition.name, { ...definition, source })
    for (const alias of definition.aliases ?? []) {
      this.ownAliases.set(alias, definition.name)
    }
  }

  get(name: string): SkillDefinition | undefined {
    const direct = this.own.get(name)
    if (direct) return direct
    const resolved = this.ownAliases.get(name)
    if (resolved) {
      const hit = this.own.get(resolved)
      if (hit) return hit
    }
    return this.base?.get(name)
  }

  getAll(): SkillDefinition[] {
    const merged = new Map<string, SkillDefinition>()
    for (const s of this.base?.getAll() ?? []) merged.set(s.name, s)
    for (const [name, s] of this.own) merged.set(name, s)
    return [...merged.values()]
  }

  getUserInvocable(): SkillDefinition[] {
    return this.getAll().filter(
      (s) => s.userInvocable !== false && (!s.isEnabled || s.isEnabled()),
    )
  }

  has(name: string): boolean {
    return this.get(name) !== undefined
  }

  unregister(name: string): boolean {
    const skill = this.own.get(name)
    if (!skill) return false
    for (const alias of skill.aliases ?? []) this.ownAliases.delete(alias)
    return this.own.delete(name)
  }

  /** Remove only filesystem-sourced (user/project) skills from THIS layer. */
  clearFilesystem(): void {
    for (const [name, skill] of [...this.own]) {
      if (skill.source === 'user' || skill.source === 'project') {
        for (const alias of skill.aliases ?? []) this.ownAliases.delete(alias)
        this.own.delete(name)
      }
    }
  }

  /** Remove everything from THIS layer (base untouched). Mainly for tests. */
  clearAll(): void {
    this.own.clear()
    this.ownAliases.clear()
  }
}

/** Module-level registry for programmatically registered skills. */
export const defaultRegistry = new SkillRegistry()

// --------------------------------------------------------------------------
// Module-level delegates (public API, unchanged behavior)
// --------------------------------------------------------------------------

export function registerSkill(definition: SkillDefinition): void {
  defaultRegistry.register(definition, 'programmatic')
}

export function getSkill(name: string): SkillDefinition | undefined {
  return defaultRegistry.get(name)
}

export function getAllSkills(): SkillDefinition[] {
  return defaultRegistry.getAll()
}

export function getUserInvocableSkills(): SkillDefinition[] {
  return defaultRegistry.getUserInvocable()
}

export function hasSkill(name: string): boolean {
  return defaultRegistry.has(name)
}

export function unregisterSkill(name: string): boolean {
  return defaultRegistry.unregister(name)
}

// --------------------------------------------------------------------------
// Allowlist filtering
// --------------------------------------------------------------------------

/**
 * Filter skills by allowlist.
 * - availableSkills undefined or empty: no filtering
 * - otherwise: allowlist entries + project-sourced skills (always allowed)
 */
export function filterSkillsByAllowlist(
  skills: SkillDefinition[],
  availableSkills?: string[],
): SkillDefinition[] {
  if (!availableSkills || availableSkills.length === 0) return skills
  return skills.filter(
    (skill) => skill.source === 'project' || availableSkills.includes(skill.name),
  )
}

// --------------------------------------------------------------------------
// Prompt formatting (unchanged from before)
// --------------------------------------------------------------------------

export interface SkillSourcesInfo {
  cwd?: string
  settingSources?: SettingSource[]
}

export function formatSkillsForSystemPrompt(
  skills?: SkillDefinition[],
  sourcesInfo?: SkillSourcesInfo,
): string {
  const invocable = skills ?? getUserInvocableSkills()
  if (invocable.length === 0) return ''

  const sorted = [...invocable].sort((a, b) => a.name.localeCompare(b.name))

  const lines: string[] = ['<available_skills>']

  lines.push('<using_skills>')
  lines.push(SYSTEM_PROMPTS.skill_guidance)
  lines.push('</using_skills>')

  const sourcesBlock = buildSourcesBlock(sourcesInfo)
  if (sourcesBlock) {
    lines.push(sourcesBlock)
  }

  for (const skill of sorted) {
    lines.push([
      '<skill>',
      `<name>${skill.name}</name>`,
      `<description>${skill.description}</description>`,
      '</skill>',
    ].join('\n'))
  }
  lines.push('</available_skills>')
  return lines.join('\n')
}

function buildSourcesBlock(info?: SkillSourcesInfo): string {
  if (!info?.settingSources || info.settingSources.length === 0) return ''
  const rows: string[] = []
  if (info.settingSources.includes('user')) {
    rows.push('user: ~/.agents/skills')
  }
  if (info.settingSources.includes('project') && info.cwd) {
    rows.push(`project: ${info.cwd}/.agents/skills`)
  }
  if (rows.length === 0) return ''
  return ['<sources>', ...rows, '</sources>'].join('\n')
}

export function formatSkillsForToolDescription(
  contextWindowTokens?: number,
  skills?: SkillDefinition[],
): string {
  const invocable = skills ?? getUserInvocableSkills()
  if (invocable.length === 0) return ''

  const CHARS_PER_TOKEN = 4
  const DEFAULT_BUDGET = 8000
  const MAX_DESC_CHARS = 250
  const budget = contextWindowTokens
    ? Math.floor(contextWindowTokens * 0.01 * CHARS_PER_TOKEN)
    : DEFAULT_BUDGET

  const sorted = [...invocable].sort((a, b) => a.name.localeCompare(b.name))
  const lines: string[] = []
  let used = 0

  for (const skill of sorted) {
    const desc =
      skill.description.length > MAX_DESC_CHARS
        ? skill.description.slice(0, MAX_DESC_CHARS) + '...'
        : skill.description

    const argHint = skill.argumentHint ? ` (args: \`${skill.argumentHint}\`)` : ''
    const line = `- **${skill.name}**${argHint}: ${desc}`

    if (used + line.length > budget) break
    lines.push(line)
    used += line.length
  }

  return ['## Available Skills', ...lines].join('\n')
}

/** @deprecated Use formatSkillsForSystemPrompt() or formatSkillsForToolDescription() instead. */
export function formatSkillsForPrompt(contextWindowTokens?: number): string {
  return formatSkillsForToolDescription(contextWindowTokens)
}

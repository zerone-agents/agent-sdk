/**
 * Filesystem Skills Loader
 *
 * Loads SKILL.md files from .agents/skills/ directories.
 */

import { readdir, readFile } from 'fs/promises'
import { existsSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { parseSkillMarkdown } from './yaml.js'
import type { SkillRegistry } from './registry.js'
import type { SkillDefinition, SkillContentBlock } from './types.js'
import type { SettingSource, SkillSource } from '../types.js'

interface LoadResult {
  loaded: number
  errors: Error[]
}

export interface ExtraDirs {
  extraUserSkillDirs?: string[]
  extraProjectSkillDirs?: string[]
}

/**
 * Load skills from filesystem directories based on settingSources.
 *
 * Loading order (later entries override earlier ones on name collision):
 *   1. ~/.agents/skills/                    (default user-level)
 *   2. extraUserSkillDirs[0], [1], ...         (additional user-level)
 *   3. <cwd>/.agents/skills/                (default project-level)
 *   4. extraProjectSkillDirs[0], [1], ...      (additional project-level)
 *
 * @param cwd - Current working directory (project root)
 * @param settingSources - Array of sources to load from
 * @param extraDirs - Additional directories to scan per level
 * @param registry - Registry to register loaded skills into
 * @returns Number of loaded skills and any errors
 */
export async function loadSkillsFromFilesystem(
  cwd: string,
  settingSources: SettingSource[] | undefined,
  extraDirs: ExtraDirs | undefined,
  registry: SkillRegistry,
): Promise<LoadResult> {
  if (!settingSources || settingSources.length === 0) {
    return { loaded: 0, errors: [] }
  }

  const errors: Error[] = []
  let loaded = 0

  // User-level skills (~/.agents/skills/)
  if (settingSources.includes('user')) {
    const userSkillsDir = join(homedir(), '.agents', 'skills')
    const result = await loadSkillsFromDir(userSkillsDir, registry, 'user')
    loaded += result.loaded
    errors.push(...result.errors)

    // Extra user-level skill directories
    for (const dir of extraDirs?.extraUserSkillDirs ?? []) {
      const r = await loadSkillsFromDir(dir, registry, 'user')
      loaded += r.loaded
      errors.push(...r.errors)
    }
  }

  // Project-level skills (./.agents/skills/)
  if (settingSources.includes('project')) {
    const projectSkillsDir = join(cwd, '.agents', 'skills')
    const result = await loadSkillsFromDir(projectSkillsDir, registry, 'project')
    loaded += result.loaded
    errors.push(...result.errors)

    // Extra project-level skill directories
    for (const dir of extraDirs?.extraProjectSkillDirs ?? []) {
      const r = await loadSkillsFromDir(dir, registry, 'project')
      loaded += r.loaded
      errors.push(...r.errors)
    }
  }

  return { loaded, errors }
}

function isDirOrSymlinkToDir(p: string, entry: import('fs').Dirent): boolean {
  if (entry.isDirectory()) return true
  if (entry.isSymbolicLink()) {
    try {
      return existsSync(p) && statSync(p).isDirectory()
    } catch {
      return false
    }
  }
  return false
}

/**
 * Load all skills from a directory.
 */
async function loadSkillsFromDir(
  dir: string,
  registry: SkillRegistry,
  source: SkillSource,
): Promise<LoadResult> {
  const errors: Error[] = []
  let loaded = 0

  try {
    const entries = await readdir(dir, { withFileTypes: true })
    const skillDirs = entries.filter(entry => isDirOrSymlinkToDir(join(dir, entry.name), entry))

    for (const skillDir of skillDirs) {
      const skillPath = join(dir, skillDir.name, 'SKILL.md')
      try {
        const definition = await loadSkillFile(dir, skillDir.name, skillPath)
        registry.register(definition, source)
        loaded++
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)))
      }
    }
  } catch (error) {
    // Directory doesn't exist or permission denied - silently skip
    if ((error as any).code !== 'ENOENT') {
      errors.push(error instanceof Error ? error : new Error(String(error)))
    }
  }

  return { loaded, errors }
}

/**
 * Load a single SKILL.md file and return its definition.
 */
async function loadSkillFile(
  baseDir: string,
  skillName: string,
  skillPath: string
): Promise<SkillDefinition> {
  const content = await readFile(skillPath, 'utf-8')
  const { frontmatter, body } = parseSkillMarkdown(content)

  const finalBody = body.replace(
    /\$\{ZERONE_AGENT_SKILL_DIR\}/g,
    join(baseDir, skillName)
  )

  const skillDir = join(baseDir, skillName)

  const definition: SkillDefinition = {
    name: frontmatter.name || skillName,
    description: frontmatter.description,
    userInvocable: frontmatter.userInvocable ?? true,
    aliases: frontmatter.aliases,
    whenToUse: frontmatter.whenToUse,
    argumentHint: frontmatter.argumentHint,
    location: skillPath,
    skillDir,
    async getPrompt(args: string): Promise<SkillContentBlock[]> {
      let text = finalBody
      if (args) {
        // Replace argument substitution placeholders if any
        text = text.replace(/\$\{args\}/g, args)
      }
      return [{ type: 'text', text }]
    },
  }

  return definition
}

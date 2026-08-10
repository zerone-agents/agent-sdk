/**
 * Filesystem Skills Loader
 *
 * Loads SKILL.md files from .agents/skills/ directories.
 * Supports nested directory structure via fs.promises.glob (Node 22+).
 */

import { glob, readFile, readdir, stat } from 'fs/promises'
import { basename, dirname, join } from 'path'
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
}

/**
 * Load skills from filesystem directories based on settingSources.
 *
 * Loading order (later entries override earlier ones on name collision):
 *   1. ~/.agents/skills/                    (default user-level)
 *   2. extraUserSkillDirs[0], [1], ...         (additional user-level)
 *   3. <cwd>/.agents/skills/                (default project-level)
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
  }

  return { loaded, errors }
}

/**
 * Load all skills from a directory tree.
 *
 * Uses fs.promises.glob (Node 22+) to find every SKILL.md anywhere in the
 * tree, supporting nested grouping directories like
 * skills/team/commit/SKILL.md.
 * The skill name is the immediate parent directory name of SKILL.md.
 *
 * Symlinks: fs.glob does NOT descend into symlinked top-level directories
 * (Dirent.isDirectory() returns false for symlinks on macOS/Linux). We
 * enumerate top-level entries ourselves and recurse into symlinked dirs
 * explicitly. The skill's skillDir stays pointing at the symlink path
 * (stable across link target changes); symlinks nested deeper than the
 * top level are not followed (loop protection, same as before).
 */
async function loadSkillsFromDir(
  dir: string,
  registry: SkillRegistry,
  source: SkillSource,
): Promise<LoadResult> {
  const errors: Error[] = []
  let loaded = 0

  const skillPaths: string[] = []
  const collectFromGlob = async (root: string) => {
    try {
      for await (const entry of glob('**/SKILL.md', { cwd: root })) {
        skillPaths.push(join(root, entry))
      }
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)))
    }
  }

  try {
    // Walk top-level entries. Real directories are scanned directly with
    // glob (handles nested layouts). Symlinked top-level directories need
    // an explicit stat — Dirent from readdir treats them as non-directories.
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const entryPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        await collectFromGlob(entryPath)
      } else if (entry.isSymbolicLink()) {
        try {
          const s = await stat(entryPath) // follows the link
          if (s.isDirectory()) {
            await collectFromGlob(entryPath)
          }
        } catch {
          // Broken symlink — ignore.
        }
      }
    }
    // Also cover a SKILL.md sitting directly at the root (non-recursive).
    try {
      for await (const entry of glob('SKILL.md', { cwd: dir })) {
        skillPaths.push(join(dir, entry))
      }
    } catch {
      // root unreadable — nothing to add
    }
  } catch (error) {
    // Unexpected error from readdir itself — surface it
    errors.push(error instanceof Error ? error : new Error(String(error)))
  }

  for (const skillPath of skillPaths) {
    try {
      const definition = await loadSkillFile(skillPath)
      registry.register(definition, source)
      loaded++
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)))
    }
  }

  return { loaded, errors }
}

/**
 * Load a single SKILL.md file and return its definition.
 *
 * Skill name and directory are derived from skillPath:
 *   skillPath = /abs/skills/team/commit/SKILL.md
 *   skillDir  = /abs/skills/team/commit
 *   skillName = commit
 */
async function loadSkillFile(skillPath: string): Promise<SkillDefinition> {
  const content = await readFile(skillPath, 'utf-8')
  const { frontmatter, body } = parseSkillMarkdown(content)

  const skillDir = dirname(skillPath)
  const skillName = basename(skillDir)

  const finalBody = body.replace(
    /\$\{ZERONE_AGENT_SKILL_DIR\}/g,
    skillDir,
  )

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

/**
 * YAML Frontmatter Parser for SKILL.md files
 *
 * Uses the `yaml` package for full YAML spec compliance.
 * Handles block scalars (>, |), nested objects, quoted strings,
 * comments, and all standard YAML syntax that a hand-rolled parser
 * cannot.
 */
import { parse as parseYaml } from 'yaml'

export interface Frontmatter {
  description: string
  name?: string
  userInvocable?: boolean
  aliases?: string[]
  whenToUse?: string
  argumentHint?: string
}

/**
 * Parse a SKILL.md file content into frontmatter and body.
 *
 * @param content - Raw SKILL.md content
 * @returns Parsed frontmatter and body
 */
export function parseSkillMarkdown(content: string): {
  frontmatter: Frontmatter
  body: string
} {
  // Normalize line endings to LF and strip BOM for consistent parsing
  const normalized = content.replace(/\r\n/g, '\n').replace(/^\uFEFF/, '')

  // Match YAML frontmatter between --- delimiters
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)

  if (!match) {
    throw new Error(
      'Invalid SKILL.md format: missing frontmatter (expected --- at start)',
    )
  }

  const frontmatterStr = match[1]
  const body = match[2]

  // Use real YAML parser — handles block scalars, nesting, quoting, comments
  let raw: Record<string, unknown>
  try {
    const parsed = parseYaml(frontmatterStr)
    raw =
      parsed && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)
        : {}
  } catch (err) {
    throw new Error(
      `Invalid YAML frontmatter: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // description is required, must be a non-empty string
  if (typeof raw.description !== 'string' || !raw.description.trim()) {
    throw new Error('SKILL.md must have a description field')
  }

  const frontmatter: Frontmatter = { description: raw.description }

  // String fields (only copy when type matches; silently ignore malformed)
  if (typeof raw.name === 'string') frontmatter.name = raw.name
  if (typeof raw['when-to-use'] === 'string')
    frontmatter.whenToUse = raw['when-to-use']
  if (typeof raw['argument-hint'] === 'string')
    frontmatter.argumentHint = raw['argument-hint']

  // Boolean fields
  if (typeof raw['user-invocable'] === 'boolean') {
    frontmatter.userInvocable = raw['user-invocable']
  }

  // Array fields — accept array, comma-separated string, or single string
  const aliases = normalizeStringArray(raw.aliases)
  if (aliases) frontmatter.aliases = aliases

  return { frontmatter, body }
}

/**
 * Normalize a value that may be an array, comma-separated string, or single string.
 * Returns undefined for missing/null/empty values (caller decides whether that's an error).
 */
function normalizeStringArray(val: unknown): string[] | undefined {
  if (val == null) return undefined
  if (Array.isArray(val)) {
    const arr = val.map((v) => String(v).trim()).filter(Boolean)
    return arr.length ? arr : undefined
  }
  const str = String(val).trim()
  if (!str) return undefined
  // Preserve historical behavior: split on ", " when present
  if (str.includes(', ')) {
    const arr = str.split(', ').map((s) => s.trim()).filter(Boolean)
    return arr.length ? arr : undefined
  }
  return [str]
}

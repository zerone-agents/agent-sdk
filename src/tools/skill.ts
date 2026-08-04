/**
 * Skill Tool
 *
 * Allows the model to invoke registered skills by name.
 * Skills are prompt templates that provide specialized capabilities.
 *
 * Two-layer injection strategy (following OpenCode design):
 * - System prompt: verbose XML listing with locations (formatSkillsForSystemPrompt)
 * - Tool description: concise Markdown for fast matching (formatSkillsForToolDescription)
 * - Tool output: <skill_content> XML with full SKILL.md content, base dir, and file listing
 */

import { glob } from 'fs/promises'
import { join } from 'path'
import { pathToFileURL } from 'url'
import type { ToolDefinition, ToolResult, ToolContext, SkillContext } from '../types.js'

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/**
 * List all files recursively under a skill directory.
 * Returns absolute paths, sampled to at most `limit` entries.
 * Uses fs.promises.glob (Node 22+).
 */
async function listSkillFiles(dir: string, limit = 20): Promise<string[]> {
  const results: string[] = []
  try {
    for await (const entry of glob('**/*', { cwd: dir, withFileTypes: true })) {
      if (!entry.isFile()) continue
      // Skip the SKILL.md itself — the content is already included inline
      if (entry.name === 'SKILL.md') continue
      // entry.parentPath is absolute (derived from cwd)
      results.push(join(entry.parentPath, entry.name))
      if (results.length >= limit) break
    }
  } catch {
    // Directory missing or unreadable — return whatever we have
  }
  return results
}

/**
 * Build the <skill_content> XML block returned to the model after invoking a skill.
 *
 * Format mirrors OpenCode's output:
 *
 *   <skill_content name="agents-sdk">
 *   # Skill: agents-sdk
 *
 *   [SKILL.md content]
 *
 *   Base directory for this skill: file:///path/to/skill/
 *   Relative paths in this skill are relative to this base directory.
 *   Note: file list is sampled.
 *
 *   <skill_files>
 *   <file>/path/to/references/callable.md</file>
 *   </skill_files>
 *   </skill_content>
 */
async function buildSkillContent(
  skillName: string,
  promptText: string,
  skillDir: string | undefined,
): Promise<string> {
  const lines: string[] = []
  lines.push(`<skill_content name="${skillName}">`)
  lines.push(`# Skill: ${skillName}`)
  lines.push('')
  lines.push(promptText)

  if (skillDir) {
    const baseDirUrl = pathToFileURL(skillDir).href + '/'
    const siblingFiles = await listSkillFiles(skillDir)

    lines.push('')
    lines.push(`Base directory for this skill: ${baseDirUrl}`)
    lines.push('Relative paths in this skill are relative to this base directory.')

    if (siblingFiles.length > 0) {
      lines.push('Note: file list is sampled.')
      lines.push('')
      lines.push('<skill_files>')
      for (const f of siblingFiles) {
        lines.push(`<file>${f}</file>`)
      }
      lines.push('</skill_files>')
    }
  }

  lines.push('</skill_content>')
  return lines.join('\n')
}

// --------------------------------------------------------------------------
// Tool definition
// --------------------------------------------------------------------------

export const SkillTool: ToolDefinition = {
  name: 'Skill',
  description:
    'Load a specialized skill that provides domain-specific instructions and workflows.\n\n' +
    'When you recognize that a task matches one of the available skills listed below, ' +
    'use this tool to load the full skill instructions.\n\n' +
     'The skill will inject detailed instructions, workflows, and access to specialized ' +
     'resources (scripts, references, templates) into the conversation context.\n\n' +
     'Tool output includes a `<skill_content name="...">` block with the loaded content.',

  inputSchema: {
    type: 'object',
    properties: {
      skill: {
        type: 'string',
        description: 'The name of the skill from available_skills (e.g., "commit", "review")',
      },
      args: {
        type: 'string',
        description: 'Optional arguments for the skill',
      },
    },
    required: ['skill'],
  },

  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  // Skill enablement is decided per-agent by the SkillContext allowlist in call();
  // the tool itself is always registered with the engine.
  isEnabled: () => true,

  async call(input: any, context: ToolContext): Promise<ToolResult> {
    const ctx = context as SkillContext
    const toolUseId = context.toolUseId || ''
    const skillName: string = input.skill
    const args: string = input.args || ''

    if (!skillName) {
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: 'Error: skill name is required',
        is_error: true,
      }
    }

    const skill = ctx.skillRegistry.get(skillName)
    if (!skill) {
      const available = ctx.resolvedSkills.map((s) => s.name).join(', ')
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: `Error: Unknown skill "${skillName}". Available skills: ${available || 'none'}`,
        is_error: true,
      }
    }

    if (skill.isEnabled && !skill.isEnabled()) {
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: `Error: Skill "${skillName}" is currently disabled`,
        is_error: true,
      }
    }

    // Note: we intentionally do NOT enforce resolvedSkills (availableSkills)
    // at runtime. The allowlist only filters what the model "sees" in the
    // system prompt; if the user/model explicitly invokes a skill by name,
    // we let it through. The user is the source of truth.

    try {
      const contentBlocks = await skill.getPrompt(args, context)

      // Extract text blocks; image blocks are preserved separately
      const textBlocks = contentBlocks.filter(
        (b): b is { type: 'text'; text: string } => b.type === 'text',
      )
      const promptText = textBlocks.map((b) => b.text).join('\n\n')

      // Build the <skill_content> XML output
      const skillContent = await buildSkillContent(skillName, promptText, skill.skillDir)

      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: skillContent,
      }
    } catch (err: any) {
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: `Error executing skill "${skillName}": ${err.message}`,
        is_error: true,
      }
    }
  },
}

/**
 * Prompt builder — extracted from engine.ts
 *
 * Builds the system prompt and its environment sub-section
 * (system context, skills, subagents, AGENTS.md).
 */

import type { QueryEngineConfig } from '../types.js'
import { getSystemContext } from '../utils/context.js'
import { loadAgentsMd } from '../utils/agents-md.js'
import { formatSkillsForSystemPrompt } from '../skills/registry.js'
import { SYSTEM_PROMPTS, resolvePrompt } from '../prompts/system-prompts.js'
import { truncateForCatalog } from '../tools/helpers.js'

/**
 * Build the environment portion of the system prompt.
 * Includes: system context, skills, subagent definitions, AGENTS.md.
 */
export async function buildEnvironmentPrompt(config: QueryEngineConfig): Promise<string> {
  const parts: string[] = []

  // Environment block (<env> XML with model identity, platform, date, etc.)
  try {
    const sysCtx = await getSystemContext(config.env.cwd, config.env.model)
    if (sysCtx) parts.push(sysCtx)
  } catch {
    // Context is best-effort
  }

  // Add skills — verbose XML format builds a complete cognitive map for the model
  const skillsXml = formatSkillsForSystemPrompt(
    config.resolved.skills,
    { cwd: config.env.cwd, settingSources: config.env.settingSources },
  )
  if (skillsXml) {
    parts.push(SYSTEM_PROMPTS.skill_guidance)
    parts.push(skillsXml)
  }

  // Add subagent definitions — XML format aligned with skills
  if (config.subAgents && Object.keys(config.subAgents).length > 0) {
    const agentEntries = Object.entries(config.subAgents).sort((a, b) => a[0].localeCompare(b[0]))
    const agentXml = agentEntries.map(([name, def]) => [
      '  <subagent>',
      `    <name>${name}</name>`,
      `    <description>${def.description}</description>`,
      '  </subagent>',
    ].join('\n'))
    parts.push([
      '<available_subagents>',
      ...agentXml,
      '</available_subagents>',
    ].join('\n'))
  }

  // Deferred tools catalog — lets the model know what's ToolSearch-able
  if (config.resolved.deferredTools.length > 0) {
    const sorted = [...config.resolved.deferredTools].sort((a, b) => a.name.localeCompare(b.name))
    const lines = sorted.map(t => {
      const summary = t.shortDescription ?? truncateForCatalog(t.description)
      return `  - ${t.name}: ${summary}`
    })
    parts.push([
      '<available_deferred_tools>',
      'These tools are available but their full schemas are NOT loaded. Use the ToolSearch tool to load a tool\'s schema before invoking it.',
      ...lines,
      '</available_deferred_tools>',
    ].join('\n'))
  }

  // Load AGENTS.md instructions (rendered as <instructions> XML block)
  const agentsMdContent = await loadAgentsMd(config.env.cwd, config.env.settingSources)
  if (agentsMdContent) {
    parts.push(agentsMdContent)
  }

  return parts.join('\n')
}

/**
 * Build the full system prompt: base prompt + environment + optional appendPrompt.
 */
export async function buildSystemPrompt(config: QueryEngineConfig): Promise<string> {
  const basePrompt = resolvePrompt(config.resolved.definition.prompt) ?? SYSTEM_PROMPTS.default
  const envPrompt = await buildEnvironmentPrompt(config)

  let result = basePrompt + '\n\n' + envPrompt

  if (config.resolved.definition.appendPrompt) {
    result += '\n\n' + config.resolved.definition.appendPrompt
  }

  return result
}

/**
 * Agent capability resolution.
 *
 * resolveAgent() computes an agent's effective tools and skills exactly
 * once; everything downstream (engine prompt, init message, Skill tool)
 * consumes the resolved sets directly — no repeated filtering.
 */

import type { AgentDefinition, AgentEnvironment, ResolvedAgent } from './types.js'
import { getAllBaseTools, assembleToolPool, filterTools } from './tools/index.js'
import { filterSkillsByAllowlist } from './skills/registry.js'

export function resolveAgent(env: AgentEnvironment, definition: AgentDefinition): ResolvedAgent {
  const pool = assembleToolPool(
    [...getAllBaseTools(), ...env.customTools],
    env.mcpTools,
  )
  const filtered = filterTools(pool, definition.allowedTools, definition.disallowedTools)

  // Lazy-loading requires FindTool to be available AND eager. If filtered
  // out (allow-list miss or deny-list hit) or marked deferred itself (a
  // misconfiguration), fall back to all-eager — otherwise deferred tools
  // would be neither visible nor discoverable.
  const lazyLoadingEnabled = filtered.some(t => t.name === 'FindTool' && !t.deferred)

  const tools = lazyLoadingEnabled ? filtered.filter(t => !t.deferred) : filtered
  const deferredTools = lazyLoadingEnabled ? filtered.filter(t => t.deferred) : []
  let skills = filterSkillsByAllowlist(
    env.skillRegistry.getUserInvocable(),
    definition.availableSkills,
  )

  // Cross-validation: if the Skill tool was filtered out, skills can't be
  // invoked through the SDK. Drop them so every downstream consumer (system
  // prompt, init event, tool-executor context, subagent resolution) stays
  // consistent instead of advertising a tool the model cannot call.
  if (!tools.some((t) => t.name === 'Skill')) {
    skills = []
  }

  return { definition, tools, skills, deferredTools }
}

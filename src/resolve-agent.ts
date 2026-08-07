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
  const tools = filterTools(pool, definition.allowedTools, definition.disallowedTools)
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

  return { definition, tools, skills }
}

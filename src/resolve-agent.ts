/**
 * Agent capability resolution.
 *
 * resolveAgent() computes an agent's effective tools and skills exactly
 * once; everything downstream (engine prompt, init message, Skill tool)
 * consumes the resolved sets directly — no repeated filtering.
 */

import type { AgentDefinition, AgentEnvironment, ResolvedAgent } from './types.js'
import { getAllBaseTools, assembleToolPool, applyAllowedTools, applyDisallowedTools } from './tools/index.js'
import { filterSkillsByAllowlist } from './skills/registry.js'

export function resolveAgent(env: AgentEnvironment, definition: AgentDefinition): ResolvedAgent {
  // Source-based filtering contract (issue #64): the allow-list gates ONLY
  // the built-in base tools; custom and MCP tools bypass it by design (hosts
  // wire MCP servers explicitly — an allow-list naming base tools must not
  // silently strip them). The deny-list applies to the whole merged pool.
  const allowedBase = applyAllowedTools(getAllBaseTools(), definition.allowedTools)
  const pool = assembleToolPool([...allowedBase, ...env.customTools], env.mcpTools)
  const filtered = applyDisallowedTools(pool, definition.disallowedTools)

  // Final-pool check lives here (not in the list filters) because only
  // resolveAgent sees the full merged picture across all sources (#64).
  if (filtered.length === 0) {
    console.warn(
      '[tools] agent resolved to zero tools — check allowedTools/disallowedTools ' +
        '(allow-list gates built-in tools only; deny-list applies to everything).',
    )
  }

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

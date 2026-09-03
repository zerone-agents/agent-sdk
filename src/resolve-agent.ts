/**
 * Agent capability resolution.
 *
 * resolveAgent() computes an agent's effective tools and skills exactly once
 * from a RuntimeEnvironment + AgentCapabilities pair; everything downstream
 * (engine prompt, init message, Skill tool) consumes the resolved sets
 * directly — no repeated filtering.
 *
 * Pipeline order (issue #72):
 *   built-ins + caps.customTools + caps.connectionTools
 *     → allow-list (built-ins only, #64) → deny-list (full pool)
 *     → [spawn] remove Task/MultiTask
 *     → [spawn·Explore] isReadOnly || Bash (deferred tools included)
 *     → lazy split (FindTool catalog)
 */

import type {
  AgentCapabilities,
  AgentDefinition,
  ResolvedAgent,
  RuntimeEnvironment,
} from './types.js'
import { getAllBaseTools, assembleToolPool, applyAllowedTools, applyDisallowedTools } from './tools/index.js'
import { SkillRegistry } from './skills/registry.js'
import { createDiagnosticsSink, type DiagnosticsSink } from './utils/diagnostics.js'

export interface ResolveAgentOptions {
  /** Spawn pipeline: removes Task/MultiTask; Explore applies the read-only safety policy. */
  spawn?: { mode: 'General' | 'Explore' }
  /** Root path: the Agent session's registry. Spawn builds a fresh one from capabilities.skills. */
  skillRegistry?: SkillRegistry
  /** Diagnostics sink (#78); defaults to the console-backed sink. */
  diagnostics?: DiagnosticsSink
}

function isReadOnlyTool(tool: { isReadOnly?: () => boolean }): boolean {
  return tool.isReadOnly?.() === true
}

export function resolveAgent(
  runtime: RuntimeEnvironment,
  capabilities: AgentCapabilities,
  definition: AgentDefinition,
  opts: ResolveAgentOptions = {},
): ResolvedAgent {
  // Source-based filtering contract (#64): allow-list gates built-ins only;
  // custom/connection tools bypass. Deny-list applies to the merged pool.
  const diagnostics = opts.diagnostics ?? createDiagnosticsSink()
  const allowedBase = applyAllowedTools(getAllBaseTools(), capabilities.allowedTools, diagnostics)
  let pool = assembleToolPool(
    [...allowedBase, ...(capabilities.customTools ?? [])],
    capabilities.connectionTools ?? [],
  )
  pool = applyDisallowedTools(pool, capabilities.disallowedTools, undefined, diagnostics)

  // Spawn pipeline (issue #72): nesting ban, then Explore dynamic safety
  // policy on the FINAL pool — deferred tools included, so write tools stay
  // undiscoverable (absent from the FindTool catalog) in Explore mode.
  if (opts.spawn) {
    pool = pool.filter((t) => t.name !== 'Task' && t.name !== 'MultiTask')
  }
  if (opts.spawn?.mode === 'Explore') {
    pool = pool.filter((t) => isReadOnlyTool(t) || t.name === 'Bash')
  }

  // Final-pool check lives here (not in the list filters) because only
  // resolveAgent sees the full merged picture across all sources (#64).
  if (pool.length === 0) {
    diagnostics.warn(
      '[tools] agent resolved to zero tools — check allowedTools/disallowedTools ' +
        '(allow-list gates built-in tools only; deny-list applies to everything).',
    )
  }

  // Lazy-loading requires FindTool to be available AND eager. If filtered
  // out (allow-list miss or deny-list hit) or marked deferred itself (a
  // misconfiguration), fall back to all-eager — otherwise deferred tools
  // would be neither visible nor discoverable.
  const lazyLoadingEnabled = pool.some(t => t.name === 'FindTool' && !t.deferred)

  const tools = lazyLoadingEnabled ? pool.filter(t => !t.deferred) : pool
  const deferredTools = lazyLoadingEnabled ? pool.filter(t => t.deferred) : []

  // Agent-owned skill set; dropped when the Skill tool is filtered out so
  // every downstream consumer (system prompt, init event, tool-executor
  // context, subagent resolution) stays consistent.
  let skills = capabilities.skills ?? []
  if (!tools.some((t) => t.name === 'Skill')) {
    skills = []
  }

  const skillRegistry = opts.spawn
    ? SkillRegistry.fromDefinitions(skills)
    : (opts.skillRegistry ?? new SkillRegistry())

  return {
    definition,
    tools,
    deferredTools,
    skills,
    services: runtime.toolServices,
    skillRegistry,
  }
}

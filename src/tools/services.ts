/**
 * ToolServices — Per-agent state isolation interface
 *
 * Defines the service dependencies that each Agent instance provides
 * to its tools, replacing the current module-level global state.
 *
 * Currently, 3 tool modules (ask-user.ts, find-tool.ts, config.ts) store
 * state in module-level variables. When multiple Agent instances coexist,
 * these globals are overwritten. ToolServices moves that state into
 * per-agent containers.
 *
 * This file defines ONLY types, interfaces, and a factory function.
 * No tool modules are modified here — consumption happens in later tasks.
 */

import type { ToolDefinition } from '../types.js'
import type { WebSearchConfig } from './web-search.js'
import type { WebFetchConfig } from './web-fetch-providers.js'
import type { CronService } from '../cron/service.js'
import type { MemoryService } from '../memory/service.js'
import { DefaultToolServices } from './default-services.js'

// NOTE (import-cycle safety): default-services.ts imports ONLY types from
// services.js (type-only imports, erased at compile time), so this runtime
// value import does not create a load-time cycle.

// ============================================================================
// Service Types
// ============================================================================

/**
 * User prompt handler — ask the user a question.
 *
 * Currently stored as module-level global in ask-user.ts:
 *   let questionHandler: ((...) => Promise<string>) | null = null
 */
export type AskUserHandler = (
  question: string,
  options: string[],
  allowMultiselect?: boolean,
) => Promise<string>

/**
 * Tool search registry — tracks deferred/lazy-loaded tools.
 *
 * Currently stored as module-level global in find-tool.ts:
 *   let deferredTools: ToolDefinition[] = []
 */
export interface FindToolRegistry {
  deferredTools: ToolDefinition[]
  /**
   * Names of tools activated via FindTool. Session-scoped: the engine
   * deliberately does NOT reset this between queries (engine.ts keeps
   * activations for the Agent's lifetime — registry identity per Agent is
   * preserved across queries, see Agent.baseToolServices). Hosts must not
   * clear it themselves or session-scoped activations break silently.
   * Used by engine.ts to merge activated deferred schemas into the per-turn tools array.
   */
  activatedTools: Set<string>
}

/**
 * Config storage — per-agent key/value configuration.
 *
 * Currently stored as module-level global in config.ts:
 *   const configStore = new Map<string, unknown>()
 */
export type ConfigState = Map<string, unknown>

// ============================================================================
// ToolServices Interface
// ============================================================================

/**
 * Per-agent tool services container.
 *
 * Each Agent instance creates its own ToolServices to provide
 * isolated state for tools that currently rely on module-level globals.
 */
export interface ToolServices {
  askUser: AskUserHandler | null
  findTool: FindToolRegistry
  config: ConfigState
  /** Optional WebSearch provider configuration; absent = anonymous Exa → Parallel default. */
  webSearch?: WebSearchConfig
  /** Optional WebFetch provider configuration; absent = anonymous Jina → local default. */
  webFetch?: WebFetchConfig
  /** Cron service shared by the CronCreate/CronDelete/CronList tools; null = not initialized. */
  cron: CronService | null
  /**
   * Memory service shared by the Memory/MemorySearch tools. OPTIONAL
   * (round-2 review P2): hosts constructing their own ToolServices WITHOUT
   * enabling memory must keep compiling — the SDK normalizes the slot
   * everywhere via `?? null` (tools, resolveAgent, resolveToolServices).
   * Absent/undefined = tools report "Memory service is not configured."
   */
  memory?: MemoryService | null
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create an empty ToolServices with default (uninitialized) state.
 *
 * Callers can set `askUser` to wire up interactive handlers.
 */
export function createEmptyServices(): ToolServices {
  return {
    askUser: null,
    findTool: {
      deferredTools: [],
      activatedTools: new Set<string>(),
    },
    config: new Map<string, unknown>(),
    cron: null,
    memory: null,
  }
}

// ============================================================================
// Per-Agent combinator
// ============================================================================

/**
 * Per-Agent ToolServices resolution (ADR 0005).
 *
 * A caller-provided ToolServices object is COMBINED into a fresh copy when a
 * cronService and/or memoryService override applies — the caller's object is
 * never mutated, so Agents sharing one container keep independent bindings.
 * Without any override the caller's object is used as-is (caller-controlled
 * sharing). Undefined slots keep the base (caller-provided or default)
 * binding — copy-on-override, never a reset.
 */
export function resolveToolServices(
  toolServices: ToolServices | undefined,
  cronService: CronService | null | undefined,
  memoryService?: MemoryService | null,
): ToolServices {
  if (!cronService && !memoryService) return toolServices ?? new DefaultToolServices()
  const base = toolServices ?? new DefaultToolServices()
  // Copy-on-override: the caller's object is never mutated; undefined slots
  // keep the base (caller-provided or default) binding.
  return {
    ...base,
    cron: cronService ?? base.cron,
    memory: memoryService ?? base.memory,
  }
}

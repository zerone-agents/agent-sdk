/**
 * ToolServices — Per-agent state isolation interface
 *
 * Defines the service dependencies that each Agent instance provides
 * to its tools, replacing the current module-level global state.
 *
 * Currently, 3 tool modules (ask-user.ts, tool-search.ts, config.ts) store
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
 * Currently stored as module-level global in tool-search.ts:
 *   let deferredTools: ToolDefinition[] = []
 */
export interface ToolSearchRegistry {
  deferredTools: ToolDefinition[]
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
  toolSearch: ToolSearchRegistry
  config: ConfigState
  /** Optional WebSearch provider configuration; absent = anonymous Exa → Parallel default. */
  webSearch?: WebSearchConfig
  /** Optional WebFetch provider configuration; absent = anonymous Jina → local default. */
  webFetch?: WebFetchConfig
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
    toolSearch: {
      deferredTools: [],
    },
    config: new Map<string, unknown>(),
  }
}

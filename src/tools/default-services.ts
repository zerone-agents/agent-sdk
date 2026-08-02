/**
 * DefaultToolServices — Default implementation of ToolServices
 *
 * Provides per-instance state storage for tool services, ensuring each
 * Agent instance gets isolated state instead of sharing module-level globals.
 *
 * Each service property is initialized with fresh state (new Map, new objects)
 * so multiple Agent instances can coexist without interfering with each other.
 */

import type { ToolDefinition } from '../types.js'
import type {
  ToolServices,
  AskUserHandler,
  ToolSearchRegistry,
  ConfigState,
} from './services.js'
import type { WebSearchConfig } from './web-search.js'

/**
 * Default implementation of ToolServices.
 *
 * Creates isolated state for each instance, matching the current module-level
 * behavior but scoped to individual Agent instances.
 */
export class DefaultToolServices implements ToolServices {
  askUser: AskUserHandler | null
  toolSearch: ToolSearchRegistry
  config: ConfigState
  /** Optional WebSearch provider configuration; absent = anonymous Exa → Parallel default. */
  webSearch?: WebSearchConfig

  constructor() {
    // No user handler by default (non-interactive mode)
    this.askUser = null

    // Initialize tool search registry with empty array
    this.toolSearch = {
      deferredTools: [],
    }

    // Initialize config storage
    this.config = new Map<string, unknown>()
  }
}

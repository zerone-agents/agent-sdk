/**
 * ConfigTool - Dynamic configuration management
 *
 * Get/set global configuration and session settings.
 */

import type { ToolDefinition, ToolResult, ToolContext } from '../types.js'
import type { ConfigState } from './services.js'

// ============================================================================
// ConfigState Helper Functions (new API)
// ============================================================================

/**
 * Get a config value from a ConfigState.
 */
export function getConfigFromState(state: ConfigState, key: string): unknown {
  return state.get(key)
}

/**
 * Set a config value in a ConfigState.
 */
export function setConfigInState(state: ConfigState, key: string, value: unknown): void {
  state.set(key, value)
}

/**
 * Clear all config in a ConfigState.
 */
export function clearConfigInState(state: ConfigState): void {
  state.clear()
}

// ============================================================================
// Backward-Compatible Shim Functions (@deprecated)
// ============================================================================

/**
 * @deprecated Module-level config storage is deprecated.
 * Use ToolServices.config instead for per-agent isolation.
 * This shim exists for backward compatibility with external callers.
 */
const legacyConfigStore: ConfigState = new Map<string, unknown>()

/**
 * Get a config value.
 * @deprecated Use ToolServices.config instead. This function uses module-level global state
 * and will be removed in a future version.
 */
export function getConfig(key: string): unknown {
  return getConfigFromState(legacyConfigStore, key)
}

/**
 * Set a config value.
 * @deprecated Use ToolServices.config instead. This function uses module-level global state
 * and will be removed in a future version.
 */
export function setConfig(key: string, value: unknown): void {
  setConfigInState(legacyConfigStore, key, value)
}

/**
 * Clear all config.
 * @deprecated Use ToolServices.config instead. This function uses module-level global state
 * and will be removed in a future version.
 */
export function clearConfig(): void {
  clearConfigInState(legacyConfigStore)
}

// ============================================================================
// ConfigTool
// ============================================================================

export const ConfigTool: ToolDefinition = {
  name: 'Config',
  description: 'Get or set configuration values. Supports session-scoped settings.',
  shortDescription: 'Read or write per-agent configuration values and session-scoped settings',
  deferred: true,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['get', 'set', 'list'],
        description: 'Operation to perform',
      },
      key: { type: 'string', description: 'Config key' },
      value: { description: 'Config value (for set)' },
    },
    required: ['action'],
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() { return 'Manage configuration settings.' },
  async call(input: any, ctx: ToolContext): Promise<ToolResult> {
    const configState = ctx.services.config

    switch (input.action) {
      case 'get': {
        if (!input.key) {
          return { type: 'tool_result', tool_use_id: '', content: 'key required for get', is_error: true }
        }
        const value = configState.get(input.key)
        return {
          type: 'tool_result',
          tool_use_id: '',
          content: value !== undefined ? JSON.stringify(value) : `Config key "${input.key}" not found`,
        }
      }
      case 'set': {
        if (!input.key) {
          return { type: 'tool_result', tool_use_id: '', content: 'key required for set', is_error: true }
        }
        configState.set(input.key, input.value)
        return {
          type: 'tool_result',
          tool_use_id: '',
          content: `Config set: ${input.key} = ${JSON.stringify(input.value)}`,
        }
      }
      case 'list': {
        const entries = Array.from(configState.entries())
        if (entries.length === 0) {
          return { type: 'tool_result', tool_use_id: '', content: 'No config values set.' }
        }
        const lines = entries.map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
        return { type: 'tool_result', tool_use_id: '', content: lines.join('\n') }
      }
      default:
        return { type: 'tool_result', tool_use_id: '', content: `Unknown action: ${input.action}`, is_error: true }
    }
  },
}

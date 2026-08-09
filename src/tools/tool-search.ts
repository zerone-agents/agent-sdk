/**
 * ToolSearchTool - Discover deferred/lazy-loaded tools
 *
 * Allows the model to search for tools that haven't been loaded yet.
 * Supports keyword search and exact name selection.
 */

import type { ToolDefinition, ToolResult, ToolContext } from '../types.js'
import type { ToolSearchRegistry } from './services.js'

// ============================================================================
// ToolSearchRegistry Helper Functions (new API)
// ============================================================================

/**
 * Set deferred tools available for search on a ToolSearchRegistry.
 */
export function setDeferredToolsInService(reg: ToolSearchRegistry, tools: ToolDefinition[]): void {
  reg.deferredTools = tools
}

/**
 * Search for deferred tools in a ToolSearchRegistry.
 */
export function searchDeferredTools(
  reg: ToolSearchRegistry,
  query: string,
  maxResults: number = 5,
): ToolDefinition[] {
  if (reg.deferredTools.length === 0) {
    return []
  }

  if (query.startsWith('select:')) {
    // Exact name selection
    const names = query.slice(7).split(',').map((n: string) => n.trim())
    return reg.deferredTools.filter(t => names.includes(t.name))
  }

  // Keyword search
  const keywords: string[] = query.toLowerCase().split(/\s+/)
  return reg.deferredTools
    .filter(t => {
      const searchText = `${t.name} ${t.description}`.toLowerCase()
      return keywords.some((kw: string) => searchText.includes(kw))
    })
    .slice(0, maxResults)
}

// ============================================================================
// Backward-Compatible Shim Functions (@deprecated)
// ============================================================================

/**
 * @deprecated Module-level deferred tools storage is deprecated.
 * Use ToolServices.toolSearch instead for per-agent isolation.
 * This shim exists for backward compatibility with external callers.
 */
const legacyRegistry: ToolSearchRegistry = {
  deferredTools: [],
  activatedTools: new Set<string>(),
}

/**
 * Set deferred tools available for search.
 * @deprecated Use ToolServices.toolSearch instead. This function uses module-level global state
 * and will be removed in a future version.
 */
export function setDeferredTools(tools: ToolDefinition[]): void {
  setDeferredToolsInService(legacyRegistry, tools)
}

// ============================================================================
// ToolSearchTool
// ============================================================================

export const ToolSearchTool: ToolDefinition = {
  name: 'ToolSearch',
  description: 'Search for additional tools that may be available but not yet loaded. Use keyword search or exact name selection.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query. Use "select:ToolName" for exact match or keywords for search.',
      },
      max_results: {
        type: 'number',
        description: 'Maximum results to return (default: 5)',
      },
    },
    required: ['query'],
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() { return 'Search for available tools.' },
  async call(input: any, ctx: ToolContext): Promise<ToolResult> {
    const { query, max_results = 5 } = input
    const registry = ctx.services.toolSearch

    if (registry.deferredTools.length === 0) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: 'No deferred tools available.',
      }
    }

    const matches = searchDeferredTools(registry, query, max_results)
    if (matches.length === 0) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `No tools found matching "${query}"`,
      }
    }

    // Activate matched tools — their schemas will appear in the next turn's
    // tools array (engine.ts reads activatedTools when rebuilding per turn).
    for (const m of matches) {
      registry.activatedTools.add(m.name)
    }

    const names = matches.map(t => t.name).join(', ')
    return {
      type: 'tool_result',
      tool_use_id: '',
      content: `Loaded ${matches.length} tool(s): ${names}. Their schemas are now available; you can invoke them directly in subsequent turns.`,
    }
  },
}

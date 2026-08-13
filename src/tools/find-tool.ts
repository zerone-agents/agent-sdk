/**
 * FindToolTool - Discover deferred/lazy-loaded tools
 *
 * Allows the model to search for tools that haven't been loaded yet.
 * Supports keyword search and exact name selection.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ToolDefinition, ToolResult, ToolContext } from '../types.js'
import type { FindToolRegistry } from './services.js'
import { truncateForCatalog } from './helpers.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

let _description: string
try {
  _description = readFileSync(join(__dirname, 'find-tool.txt'), 'utf-8')
} catch {
  _description = 'Search for additional tools that may be available but not yet loaded.'
}

// ============================================================================
// FindToolRegistry Helper Functions (new API)
// ============================================================================

/**
 * Set deferred tools available for search on a FindToolRegistry.
 */
export function setDeferredToolsInService(reg: FindToolRegistry, tools: ToolDefinition[]): void {
  reg.deferredTools = tools
}

/**
 * Search for deferred tools in a FindToolRegistry.
 */
export function searchDeferredTools(
  reg: FindToolRegistry,
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
 * Use ToolServices.findTool instead for per-agent isolation.
 * This shim exists for backward compatibility with external callers.
 */
const legacyRegistry: FindToolRegistry = {
  deferredTools: [],
  activatedTools: new Set<string>(),
}

/**
 * Set deferred tools available for search.
 * @deprecated Use ToolServices.findTool instead. This function uses module-level global state
 * and will be removed in a future version.
 */
export function setDeferredTools(tools: ToolDefinition[]): void {
  setDeferredToolsInService(legacyRegistry, tools)
}

// ============================================================================
// FindToolTool
// ============================================================================

export const FindToolTool: ToolDefinition = {
  name: 'FindTool',
  description: _description,
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
  async prompt() { return _description },
  async call(input: any, ctx: ToolContext): Promise<ToolResult> {
    const { query, max_results = 5 } = input
    const registry = ctx.services.findTool

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

    // Self-contained summary: each tool's Name + shortDescription (or fallback
    // to description slice) so the model knows what each one does without
    // having to cross-reference <available_deferred_tools> in the system prompt.
    const lines = matches.map(t => {
      const summary = t.shortDescription ?? truncateForCatalog(t.description)
      return `- ${t.name}: ${summary}`
    })
    return {
      type: 'tool_result',
      tool_use_id: '',
      content: `Loaded ${matches.length} tool(s):\n${lines.join('\n')}\n\nTheir schemas are now available; you can invoke them directly in subsequent turns.`,
    }
  },
}

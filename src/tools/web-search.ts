/**
 * WebSearchTool - Web search via configurable MCP providers (Exa, Parallel).
 *
 * Config flows in through ToolServices.webSearch; with no config the tool
 * defaults to anonymous Exa with anonymous Parallel as fallback (no API
 * keys required), sharing a 25s timeout budget.
 */

import { defineTool } from './types.js'
import { buildProviders } from './web-search-providers.js'

export interface ExaProviderConfig {
  provider: 'exa'
  /** Absent = anonymous (backward-compatible default). Sent as x-api-key header. */
  apiKey?: string
  /** Default: https://mcp.exa.ai/mcp */
  endpoint?: string
}

export interface ParallelProviderConfig {
  provider: 'parallel'
  /** Optional — anonymous requests allowed but rate-limited. Sent as Authorization: Bearer. */
  apiKey?: string
  /** Default: https://search.parallel.ai/mcp */
  endpoint?: string
}

export type SearchProviderConfig = ExaProviderConfig | ParallelProviderConfig

export interface WebSearchConfig {
  /** Ordered providers; empty array behaves like the default (anonymous Exa → Parallel). */
  providers: SearchProviderConfig[]
  /** Total timeout shared across the whole attempt sequence. Default 25000. */
  timeoutMs?: number
}

export const WebSearchTool = defineTool({
  name: 'WebSearch',
  description:
    'Search the web using Exa AI for real-time information. Returns results with titles, URLs, and snippets. Use for current events, recent data, or information beyond knowledge cutoff.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query',
      },
      numResults: {
        type: 'number',
        description: 'Number of results to return (default: 8)',
      },
      livecrawl: {
        type: 'string',
        enum: ['fallback', 'preferred'],
        description:
          "Live crawl mode - 'fallback': use if cached unavailable, 'preferred': prioritize live crawling",
      },
      type: {
        type: 'string',
        enum: ['auto', 'fast', 'deep'],
        description: "Search type - 'auto': balanced, 'fast': quick, 'deep': comprehensive",
      },
    },
    required: ['query'],
  },
  isReadOnly: true,
  isConcurrencySafe: true,
  async call(input, context) {
    const { query, numResults = 8, livecrawl = 'fallback', type = 'auto' } = input

    const config = context.services?.webSearch
    const providers = buildProviders(config)
    const deadlineMs = Date.now() + (config?.timeoutMs ?? 25000)

    let lastErrorMessage: string | null = null
    for (const provider of providers) {
      if (Date.now() >= deadlineMs) {
        return {
          data: lastErrorMessage ?? `Search timeout after ${Math.round((config?.timeoutMs ?? 25000) / 1000)} seconds`,
          is_error: true,
        }
      }

      const outcome = await provider.search(query, {
        numResults,
        livecrawl,
        type,
        deadlineMs,
        abortSignal: context.abortSignal,
      })

      if (outcome.ok) return outcome.text
      if (!outcome.retryable) return { data: outcome.message, is_error: true }
      lastErrorMessage = outcome.message
    }

    return { data: lastErrorMessage ?? 'Search failed', is_error: true }
  },
})

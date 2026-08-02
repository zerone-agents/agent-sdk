/**
 * WebSearch provider abstraction + error-parsing helpers.
 *
 * See docs/superpowers/specs/2026-07-31-web-search-resilience-design.md.
 */

import type { WebSearchConfig } from './web-search.js'

export interface McpResponse {
  result?: {
    content?: Array<{ type: string; text: string }>
    isError?: boolean
  }
  error?: {
    message: string
  }
}

/**
 * Parse an MCP response body. Servers may answer with either a plain JSON
 * body (Content-Type: application/json) or an SSE stream containing
 * `data: {...}` lines — handle both.
 */
export function parseSse(body: string): McpResponse | null {
  const trimmed = body.trim()
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return null
    }
  }
  const lines = body.split('\n')
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      try {
        return JSON.parse(line.slice(6))
      } catch {
        continue
      }
    }
  }
  return null
}

/** Read a response body, capped at maxBytes (default 8 KB). */
export async function readBoundedBody(
  response: Response,
  maxBytes = 8192,
): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      total += value.length
    }
  } finally {
    reader.cancel().catch(() => {})
  }
  const merged = new Uint8Array(Math.min(total, maxBytes))
  let offset = 0
  for (const chunk of chunks) {
    const slice = chunk.subarray(0, Math.min(chunk.length, maxBytes - offset))
    merged.set(slice, offset)
    offset += slice.length
    if (offset >= maxBytes) break
  }
  return new TextDecoder().decode(merged)
}

/**
 * Pull a human-readable upstream error message out of a response body.
 * Tries SSE JSON-RPC error.message, then plain JSON error.message / message.
 * Returns null when nothing parses.
 */
export function extractUpstreamMessage(body: string): string | null {
  const fromSse = parseSse(body)
  if (fromSse?.error?.message) return fromSse.error.message

  try {
    const parsed = JSON.parse(body)
    if (typeof parsed?.error?.message === 'string') return parsed.error.message
    if (typeof parsed?.message === 'string') return parsed.message
  } catch {
    // not JSON
  }
  return null
}

/**
 * Normalize a Retry-After header (integer seconds or HTTP-date) into a
 * human-readable delay: "47s", "1m 30s", "13h 42m", "2d 3h".
 */
export function normalizeRetryAfter(
  header: string | null,
  nowMs = Date.now(),
): string | undefined {
  if (header === null) return undefined
  const trimmed = header.trim()

  let totalSeconds: number
  if (/^\d+$/.test(trimmed)) {
    totalSeconds = parseInt(trimmed, 10)
  } else {
    const dateMs = Date.parse(trimmed)
    if (Number.isNaN(dateMs)) return undefined
    totalSeconds = Math.max(0, Math.round((dateMs - nowMs) / 1000))
  }

  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
  return `${seconds}s`
}

/** Strip HTML tags, collapse whitespace, truncate to maxLen (default 500). */
export function sanitize(text: string, maxLen = 500): string {
  const cleaned = text
    .replace(/<[^>]*>/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned
}

export interface SearchOptions {
  numResults: number
  livecrawl: 'fallback' | 'preferred'
  type: 'auto' | 'fast' | 'deep'
  /** Absolute deadline (ms epoch) shared across the whole attempt sequence. */
  deadlineMs: number
  abortSignal?: AbortSignal
}

export type SearchOutcome =
  | { ok: true; text: string }
  | {
      ok: false
      retryable: boolean
      status?: number
      retryAfter?: string
      message: string
    }

export interface SearchProvider {
  readonly name: string
  search(query: string, opts: SearchOptions): Promise<SearchOutcome>
}

/** Replace every occurrence of the API key in text with "***". */
export function maskCredentials(text: string, apiKey?: string): string {
  if (!apiKey) return text
  return text.split(apiKey).join('***')
}

interface McpCallConfig {
  endpoint: string
  headers: Record<string, string>
  toolName: string
  toolArguments: Record<string, unknown>
  providerName: string
  apiKey?: string
  /** Message returned when a success envelope has no text content. */
  emptyMessage: string
}

/** Shared MCP-over-SSE transport for search providers. */
export async function postMcp(
  cfg: McpCallConfig,
  opts: SearchOptions,
): Promise<SearchOutcome> {
  const remainingMs = opts.deadlineMs - Date.now()
  if (remainingMs <= 0) {
    return {
      ok: false,
      retryable: true,
      message: `Search timeout via ${cfg.providerName}`,
    }
  }

  const request = {
    jsonrpc: '2.0' as const,
    id: 1,
    method: 'tools/call' as const,
    params: { name: cfg.toolName, arguments: cfg.toolArguments },
  }

  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), remainingMs)

    const signals = [controller.signal]
    if (opts.abortSignal) signals.push(opts.abortSignal)

    let response: Response
    try {
      response = await fetch(cfg.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...cfg.headers,
        },
        body: JSON.stringify(request),
        signal: AbortSignal.any(signals),
      })
    } finally {
      clearTimeout(timeoutId)
    }

    if (!response.ok) {
      const body = await readBoundedBody(response)
      const upstream = extractUpstreamMessage(body)
      const retryAfter = normalizeRetryAfter(response.headers.get('Retry-After'))
      const retryable = response.status === 429 || response.status >= 500

      if (!upstream) {
        const parts = [`Search failed via ${cfg.providerName}: HTTP ${response.status}`]
        if (retryAfter) parts.push(`Retry after ${retryAfter}.`)
        return {
          ok: false,
          retryable,
          status: response.status,
          retryAfter,
          message: parts.join(' '),
        }
      }

      const detail = maskCredentials(sanitize(upstream), cfg.apiKey)
      const parts = [
        `Search failed via ${cfg.providerName}: HTTP ${response.status}. ${detail}`,
      ]
      if (retryAfter) parts.push(`Retry after ${retryAfter}.`)
      return {
        ok: false,
        retryable,
        status: response.status,
        retryAfter,
        message: parts.join(' '),
      }
    }

    const body = await response.text()
    const mcpResponse = parseSse(body)

    if (mcpResponse?.error) {
      return {
        ok: false,
        retryable: false,
        message: `Search error via ${cfg.providerName}: ${maskCredentials(sanitize(mcpResponse.error.message), cfg.apiKey)}`,
      }
    }

    const text = mcpResponse?.result?.content?.[0]?.text
    // Servers may signal tool-level errors (e.g. Exa's invalid API key) as
    // HTTP 200 with result.isError=true. Treat as a non-retryable failure so
    // the detailed upstream message reaches the caller instead of being
    // mistaken for successful result text.
    if (mcpResponse?.result?.isError) {
      const detail = text ? maskCredentials(sanitize(text), cfg.apiKey) : 'unknown upstream error'
      return {
        ok: false,
        retryable: false,
        message: `Search failed via ${cfg.providerName}: ${detail}`,
      }
    }
    if (text) return { ok: true, text }
    return { ok: true, text: cfg.emptyMessage }
  } catch (err: any) {
    if (opts.abortSignal?.aborted) {
      return { ok: false, retryable: false, message: 'Search aborted' }
    }
    if (err.name === 'AbortError') {
      return {
        ok: false,
        retryable: true,
        message: `Search timeout via ${cfg.providerName}`,
      }
    }
    return {
      ok: false,
      retryable: true,
      message: `Search error via ${cfg.providerName}: ${maskCredentials(err.message, cfg.apiKey)}`,
    }
  }
}

const EXA_DEFAULT_ENDPOINT = 'https://mcp.exa.ai/mcp'

export class ExaProvider implements SearchProvider {
  readonly name = 'Exa'
  private readonly endpoint: string
  private readonly apiKey?: string

  constructor(cfg: { provider: 'exa'; apiKey?: string; endpoint?: string }) {
    this.endpoint = cfg.endpoint ?? EXA_DEFAULT_ENDPOINT
    this.apiKey = cfg.apiKey
  }

  search(query: string, opts: SearchOptions): Promise<SearchOutcome> {
    const headers: Record<string, string> = {}
    if (this.apiKey) headers['x-api-key'] = this.apiKey

    return postMcp(
      {
        endpoint: this.endpoint,
        headers,
        toolName: 'web_search_exa',
        toolArguments: {
          query,
          type: opts.type,
          numResults: opts.numResults,
          livecrawl: opts.livecrawl,
        },
        providerName: this.name,
        apiKey: this.apiKey,
        emptyMessage: `No results found for "${query}"`,
      },
      opts,
    )
  }
}

const PARALLEL_DEFAULT_ENDPOINT = 'https://search.parallel.ai/mcp'

export class ParallelProvider implements SearchProvider {
  readonly name = 'Parallel'
  private readonly endpoint: string
  private readonly apiKey?: string

  constructor(cfg: { provider: 'parallel'; apiKey?: string; endpoint?: string }) {
    this.endpoint = cfg.endpoint ?? PARALLEL_DEFAULT_ENDPOINT
    this.apiKey = cfg.apiKey
  }

  search(query: string, opts: SearchOptions): Promise<SearchOutcome> {
    const headers: Record<string, string> = {}
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`

    return postMcp(
      {
        endpoint: this.endpoint,
        headers,
        toolName: 'web_search',
        toolArguments: { objective: query, search_queries: [query] },
        providerName: this.name,
        apiKey: this.apiKey,
        emptyMessage: `No results found for "${query}"`,
      },
      opts,
    )
  }
}

/**
 * Build the ordered provider chain. With no config (or an empty providers
 * list) the default is resilience out of the box: anonymous Exa first,
 * anonymous Parallel as fallback — no API keys required.
 */
export function buildProviders(config?: WebSearchConfig): SearchProvider[] {
  if (!config || config.providers.length === 0) {
    return [
      new ExaProvider({ provider: 'exa' }),
      new ParallelProvider({ provider: 'parallel' }),
    ]
  }
  return config.providers.map((p) =>
    p.provider === 'exa' ? new ExaProvider(p) : new ParallelProvider(p),
  )
}

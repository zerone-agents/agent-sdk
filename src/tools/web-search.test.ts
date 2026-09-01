import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ExaProvider,
  ParallelProvider,
  buildProviders,
  extractUpstreamMessage,
  normalizeRetryAfter,
  readBoundedBody,
  sanitize,
} from './web-search-providers.js'
import { WebSearchTool } from './web-search.js'
import { createEmptyServices } from './services.js'
import type { WebSearchConfig } from './web-search.js'
import type { ToolContext } from '../types.js'

function sseResponse(payload: unknown): Response {
  return new Response(`data: ${JSON.stringify(payload)}\n\n`, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

function searchResult(text: string): unknown {
  return {
    jsonrpc: '2.0',
    id: 1,
    result: { content: [{ type: 'text', text }] },
  }
}

const baseOpts = {
  numResults: 5,
  livecrawl: 'fallback' as const,
  type: 'auto' as const,
  deadlineMs: Date.now() + 25_000,
}

describe('readBoundedBody', () => {
  it('returns the full body when under the cap', async () => {
    const response = new Response('short body')
    expect(await readBoundedBody(response)).toBe('short body')
  })

  it('truncates bodies larger than 8 KB', async () => {
    const big = 'x'.repeat(10_000)
    const response = new Response(big)
    const body = await readBoundedBody(response)
    expect(body.length).toBe(8192)
    expect(body).toBe('x'.repeat(8192))
  })
})

describe('extractUpstreamMessage', () => {
  it('parses JSON-RPC error.message from SSE data lines', () => {
    const body = [
      'event: message',
      'data: {"jsonrpc":"2.0","id":1,"error":{"message":"rate limit hit"}}',
      '',
    ].join('\n')
    expect(extractUpstreamMessage(body)).toBe('rate limit hit')
  })

  it('parses plain JSON error.message', () => {
    expect(extractUpstreamMessage('{"error":{"message":"bad key"}}')).toBe('bad key')
  })

  it('parses plain JSON top-level message', () => {
    expect(extractUpstreamMessage('{"message":"nope"}')).toBe('nope')
  })

  it('returns null for unparseable bodies', () => {
    expect(extractUpstreamMessage('<html>oops</html>')).toBeNull()
  })
})

describe('normalizeRetryAfter', () => {
  it('returns undefined for null input', () => {
    expect(normalizeRetryAfter(null)).toBeUndefined()
  })

  it('renders plain seconds', () => {
    expect(normalizeRetryAfter('47')).toBe('47s')
  })

  it('renders hours and minutes', () => {
    expect(normalizeRetryAfter(String(13 * 3600 + 42 * 60))).toBe('13h 42m')
  })

  it('renders days and hours', () => {
    expect(normalizeRetryAfter(String(2 * 86400 + 3 * 3600))).toBe('2d 3h')
  })

  it('parses HTTP-dates relative to nowMs', () => {
    const now = Date.parse('Wed, 31 Jul 2026 10:00:00 GMT')
    const later = new Date(now + 90_000).toUTCString()
    expect(normalizeRetryAfter(later, now)).toBe('1m 30s')
  })

  it('returns undefined for unparseable values', () => {
    expect(normalizeRetryAfter('soon')).toBeUndefined()
  })
})

describe('sanitize', () => {
  it('strips HTML tags and collapses whitespace', () => {
    expect(sanitize('<b>Rate</b>   limited\n\nnow')).toBe('Rate limited now')
  })

  it('truncates to 500 chars by default', () => {
    expect(sanitize('y'.repeat(600)).length).toBe(500)
  })

  it('strips control characters but keeps normal whitespace handling', () => {
    expect(sanitize('bad\x00\x07text\x1F here')).toBe('badtext here')
  })
})

describe('ExaProvider', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends an anonymous request without auth headers by default', async () => {
    vi.mocked(fetch).mockResolvedValue(sseResponse(searchResult('results here')))

    const provider = new ExaProvider({ provider: 'exa' })
    const outcome = await provider.search('test query', baseOpts)

    expect(outcome).toEqual({ ok: true, text: 'results here' })
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(url).toBe('https://mcp.exa.ai/mcp')
    const headers = init?.headers as Record<string, string>
    expect(headers['x-api-key']).toBeUndefined()
    expect(headers['Authorization']).toBeUndefined()
    const body = JSON.parse(init?.body as string)
    expect(body.params.name).toBe('web_search_exa')
    expect(body.params.arguments).toEqual({
      query: 'test query',
      type: 'auto',
      numResults: 5,
      livecrawl: 'fallback',
    })
  })

  it('sends the API key as x-api-key header when configured', async () => {
    vi.mocked(fetch).mockResolvedValue(sseResponse(searchResult('ok')))

    const provider = new ExaProvider({ provider: 'exa', apiKey: 'secret-key-123' })
    await provider.search('q', baseOpts)

    const headers = vi.mocked(fetch).mock.calls[0][1]?.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('secret-key-123')
  })

  it('treats HTTP 200 with result.isError=true as a non-retryable failure', async () => {
    // Exa reports an invalid API key this way instead of using HTTP 401.
    vi.mocked(fetch).mockResolvedValue(
      sseResponse({
        jsonrpc: '2.0',
        id: 1,
        result: {
          content: [{ type: 'text', text: 'web_search_exa error (401): Invalid API key' }],
          isError: true,
        },
      }),
    )

    const provider = new ExaProvider({ provider: 'exa', apiKey: 'bogus' })
    const outcome = await provider.search('q', baseOpts)

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.retryable).toBe(false)
      expect(outcome.message).toContain('Invalid API key')
    }
  })

  it('returns detailed 429 errors with upstream message and Retry-After', async () => {
    const errorBody = `data: ${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      error: { message: 'Anonymous MCP quota exhausted. Create an API key.' },
    })}\n\n`
    vi.mocked(fetch).mockResolvedValue(
      new Response(errorBody, { status: 429, headers: { 'Retry-After': '49320' } }),
    )

    const provider = new ExaProvider({ provider: 'exa' })
    const outcome = await provider.search('q', baseOpts)

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.retryable).toBe(true)
      expect(outcome.status).toBe(429)
      expect(outcome.retryAfter).toBe('13h 42m')
      expect(outcome.message).toContain('Anonymous MCP quota exhausted')
      expect(outcome.message).toContain('13h 42m')
    }
  })

  it('treats 401 as non-retryable', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('{"error":{"message":"invalid key"}}', { status: 401 }))

    const provider = new ExaProvider({ provider: 'exa', apiKey: 'bad' })
    const outcome = await provider.search('q', baseOpts)

    expect(outcome).toMatchObject({ ok: false, retryable: false, status: 401 })
  })

  it('falls back to status-only message when the body is unparseable', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('<html>proxy error</html>', { status: 503 }))

    const provider = new ExaProvider({ provider: 'exa' })
    const outcome = await provider.search('q', baseOpts)

    expect(outcome).toMatchObject({ ok: false, retryable: true, status: 503 })
    if (!outcome.ok) {
      expect(outcome.message).toBe('Search failed via Exa: HTTP 503')
    }
  })

  it('masks the configured API key inside upstream error text', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        `data: ${JSON.stringify({ error: { message: 'key secret-key-123 rejected' } })}\n\n`,
        { status: 401 },
      ),
    )

    const provider = new ExaProvider({ provider: 'exa', apiKey: 'secret-key-123' })
    const outcome = await provider.search('q', baseOpts)

    if (!outcome.ok) {
      expect(outcome.message).not.toContain('secret-key-123')
      expect(outcome.message).toContain('***')
    }
  })

  it('returns a retryable timeout outcome when the deadline has passed', async () => {
    const provider = new ExaProvider({ provider: 'exa' })
    const outcome = await provider.search('q', { ...baseOpts, deadlineMs: Date.now() - 1 })

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.retryable).toBe(true)
      expect(outcome.message).toContain('timeout')
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it('returns a retryable outcome on network errors', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('ECONNRESET'))

    const provider = new ExaProvider({ provider: 'exa' })
    const outcome = await provider.search('q', baseOpts)

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.retryable).toBe(true)
      expect(outcome.message).toContain('ECONNRESET')
    }
  })

  it('returns the no-results message when content is empty', async () => {
    vi.mocked(fetch).mockResolvedValue(sseResponse({ jsonrpc: '2.0', id: 1, result: {} }))

    const provider = new ExaProvider({ provider: 'exa' })
    const outcome = await provider.search('obscure thing', baseOpts)

    expect(outcome).toEqual({ ok: true, text: 'No results found for "obscure thing"' })
  })

  it('classifies a caller abort mid-flight as non-retryable', async () => {
    const controller = new AbortController()
    vi.mocked(fetch).mockImplementation((_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        })
        setTimeout(() => controller.abort(), 10)
      })
    })

    const provider = new ExaProvider({ provider: 'exa' })
    const outcome = await provider.search('q', { ...baseOpts, abortSignal: controller.signal })

    expect(outcome).toEqual({ ok: false, retryable: false, message: 'Search aborted' })
  })

  it('classifies an AbortError without a caller signal as a retryable timeout', async () => {
    vi.mocked(fetch).mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }))

    const provider = new ExaProvider({ provider: 'exa' })
    const outcome = await provider.search('q', baseOpts)

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.retryable).toBe(true)
      expect(outcome.message).toContain('timeout')
    }
  })

  it('treats a caller abort with a custom reason as non-retryable', async () => {
    const controller = new AbortController()
    const reason = new Error('host cancelled')
    vi.mocked(fetch).mockRejectedValue(reason)
    controller.abort(reason)

    const provider = new ExaProvider({ provider: 'exa' })
    const outcome = await provider.search('q', { ...baseOpts, abortSignal: controller.signal })

    expect(outcome).toEqual({ ok: false, retryable: false, message: 'Search aborted' })
  })

  it('includes Retry-After in the message even when the error body is unparseable', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('<html>gateway error</html>', {
        status: 429,
        headers: { 'Retry-After': '120' },
      }),
    )

    const provider = new ExaProvider({ provider: 'exa' })
    const outcome = await provider.search('q', baseOpts)

    expect(outcome).toMatchObject({ ok: false, retryable: true, status: 429, retryAfter: '2m' })
    if (!outcome.ok) {
      expect(outcome.message).toBe('Search failed via Exa: HTTP 429 Retry after 2m.')
    }
  })
})

describe('ParallelProvider', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('maps the query onto objective + search_queries', async () => {
    vi.mocked(fetch).mockResolvedValue(sseResponse(searchResult('parallel results')))

    const provider = new ParallelProvider({ provider: 'parallel', apiKey: 'pkey' })
    const outcome = await provider.search('金粒门', baseOpts)

    expect(outcome).toEqual({ ok: true, text: 'parallel results' })
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(url).toBe('https://search.parallel.ai/mcp')
    const headers = init?.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer pkey')
    const body = JSON.parse(init?.body as string)
    expect(body.params.name).toBe('web_search')
    expect(body.params.arguments).toEqual({
      objective: '金粒门',
      search_queries: ['金粒门'],
    })
  })

  it('sends no Authorization header when apiKey is absent (anonymous)', async () => {
    vi.mocked(fetch).mockResolvedValue(sseResponse(searchResult('anon ok')))

    const provider = new ParallelProvider({ provider: 'parallel' })
    const outcome = await provider.search('q', baseOpts)

    expect(outcome.ok).toBe(true)
    const headers = vi.mocked(fetch).mock.calls[0][1]?.headers as Record<string, string>
    expect(headers['Authorization']).toBeUndefined()
  })

  it('parses a plain JSON response (Content-Type: application/json)', async () => {
    // Parallel currently answers with a plain JSON body, not an SSE stream.
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(searchResult('json results')), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const provider = new ParallelProvider({ provider: 'parallel' })
    const outcome = await provider.search('q', baseOpts)

    expect(outcome).toEqual({ ok: true, text: 'json results' })
  })

  it('treats 429 as retryable with a detailed message', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('{"error":{"message":"rate limited"}}', {
        status: 429,
        headers: { 'Retry-After': '30' },
      }),
    )

    const provider = new ParallelProvider({ provider: 'parallel' })
    const outcome = await provider.search('q', baseOpts)

    expect(outcome).toMatchObject({ ok: false, retryable: true, status: 429, retryAfter: '30s' })
    if (!outcome.ok) {
      expect(outcome.message).toContain('rate limited')
      expect(outcome.message).toContain('30s')
    }
  })
})

describe('buildProviders', () => {
  it('defaults to anonymous Exa → Parallel when config is undefined', () => {
    const providers = buildProviders(undefined)
    expect(providers).toHaveLength(2)
    expect(providers[0]).toBeInstanceOf(ExaProvider)
    expect(providers[1]).toBeInstanceOf(ParallelProvider)
  })

  it('defaults to anonymous Exa → Parallel for an empty list', () => {
    const providers = buildProviders({ providers: [] })
    expect(providers).toHaveLength(2)
    expect(providers[0]).toBeInstanceOf(ExaProvider)
    expect(providers[1]).toBeInstanceOf(ParallelProvider)
  })

  it('builds the configured providers in order', () => {
    const providers = buildProviders({
      providers: [
        { provider: 'parallel', apiKey: 'p' },
        { provider: 'exa', apiKey: 'e' },
      ],
    })
    expect(providers).toHaveLength(2)
    expect(providers[0]).toBeInstanceOf(ParallelProvider)
    expect(providers[1]).toBeInstanceOf(ExaProvider)
  })
})

function makeCtx(config?: WebSearchConfig): ToolContext {
  const services = createEmptyServices()
  if (config) services.webSearch = config
  return { cwd: process.cwd(), agentId: 'test-agent', services, subprocessEnv: { ...process.env } }
}

describe('WebSearchTool fallback loop', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('works with a bare context (no services) — example-19 shape', async () => {
    vi.mocked(fetch).mockResolvedValue(sseResponse(searchResult('bare ok')))

    const result = await WebSearchTool.call(
      { query: 'hello' },
      { cwd: process.cwd() } as any,
    )

    expect(result.is_error).toBeFalsy()
    expect(result.content).toBe('bare ok')
  })

  it('falls back to the next provider on 429', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response('{"error":{"message":"exa quota"}}', { status: 429 }),
      )
      .mockResolvedValueOnce(sseResponse(searchResult('parallel saved us')))

    const result = await WebSearchTool.call(
      { query: 'q', numResults: 3 },
      makeCtx({ providers: [{ provider: 'exa' }, { provider: 'parallel' }] }),
    )

    expect(result.is_error).toBeFalsy()
    expect(result.content).toBe('parallel saved us')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('falls back Exa → Parallel by default (no config at all)', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response('{"error":{"message":"anon quota exhausted"}}', { status: 429 }),
      )
      .mockResolvedValueOnce(sseResponse(searchResult('default chain works')))

    const result = await WebSearchTool.call({ query: 'q' }, makeCtx())

    expect(result.is_error).toBeFalsy()
    expect(result.content).toBe('default chain works')
    expect(fetch).toHaveBeenCalledTimes(2)
    // First call hit Exa, second hit Parallel.
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('https://mcp.exa.ai/mcp')
    expect(vi.mocked(fetch).mock.calls[1][0]).toBe('https://search.parallel.ai/mcp')
  })

  it('does NOT fall back on 401', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('{"error":{"message":"bad key"}}', { status: 401 }),
    )

    const result = await WebSearchTool.call(
      { query: 'q' },
      makeCtx({ providers: [{ provider: 'exa', apiKey: 'leaked-secret' }, { provider: 'parallel' }] }),
    )

    expect(result.is_error).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(String(result.content)).toContain('bad key')
  })

  it('returns the last provider error when all fail retryably', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response('{"error":{"message":"exa down"}}', { status: 503 }))
      .mockResolvedValueOnce(new Response('{"error":{"message":"parallel limited"}}', { status: 429 }))

    const result = await WebSearchTool.call(
      { query: 'q' },
      makeCtx({ providers: [{ provider: 'exa' }, { provider: 'parallel' }] }),
    )

    expect(result.is_error).toBe(true)
    expect(String(result.content)).toContain('parallel limited')
  })

  it('stops after the shared timeout budget is exhausted', async () => {
    vi.mocked(fetch).mockImplementation((_url, init) => {
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(sseResponse(searchResult('late'))), 200)
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        })
      })
    })

    const result = await WebSearchTool.call(
      { query: 'q' },
      makeCtx({
        providers: [{ provider: 'exa' }, { provider: 'parallel' }],
        timeoutMs: 50,
      }),
    )

    expect(result.is_error).toBe(true)
    expect(String(result.content)).toContain('timeout')
  })

  it('propagates a caller abort signal without falling back', async () => {
    const controller = new AbortController()
    vi.mocked(fetch).mockImplementation((_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        })
        setTimeout(() => controller.abort(), 10)
      })
    })

    const ctx = makeCtx({ providers: [{ provider: 'exa' }, { provider: 'parallel' }] })
    const result = await WebSearchTool.call(
      { query: 'q' },
      { ...ctx, abortSignal: controller.signal },
    )

    expect(result.is_error).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

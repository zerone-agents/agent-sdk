/**
 * Integration tests for WebFetchTool (Task 6).
 *
 * Lives in a separate file from web-fetch.test.ts because mocking
 * `buildProviders` here would also override it for the buildProviders
 * describe block in web-fetch.test.ts (vitest hoists `vi.mock` to the
 * module level). Isolating the mock keeps the LocalProvider/JinaProvider/
 * FirecrawlProvider/buildProviders tests in web-fetch.test.ts intact while
 * letting us inject fake providers here.
 */

import { describe, it, expect, vi } from 'vitest'
import { WebFetchTool } from './web-fetch.js'

// Mock only buildProviders so we can inject fake providers via
// context.services.webFetch.__testProviders. Other exports (provider
// classes, types) are passthrough from the real module.
vi.mock('./web-fetch-providers.js', async (importOriginal) => {
  const actual: any = await importOriginal()
  return {
    ...actual,
    buildProviders: (_config: any) => _config?.__testProviders ?? [],
  }
})

describe('WebFetchTool', () => {
  function makeProvider(
    outcome:
      | { ok: true; content: string; metadata: any }
      | { ok: false; retryable: boolean; message: string },
    name = 'fake',
  ): any {
    return {
      name,
      fetch: async () => outcome,
    }
  }

  it('returns content with metadata header when provider succeeds', async () => {
    const result: any = await WebFetchTool.call(
      { url: 'https://x.com' },
      {
        cwd: '',
        sessionId: 't',
        services: {
          webFetch: {
            __testProviders: [
              makeProvider({
                ok: true,
                content: '# Hello\n\nWorld',
                metadata: {
                  title: 'Hello',
                  finalUrl: 'https://x.com',
                  contentType: 'text/html',
                  contentLength: 13,
                  provider: 'jina',
                  extracted: true,
                },
              }),
            ],
          },
        },
      } as any,
    )

    expect(result.is_error).toBe(false)
    expect(result.content).toContain('Title: Hello')
    expect(result.content).toContain('URL: https://x.com')
    expect(result.content).toContain('Provider: jina')
    expect(result.content).toContain('Extracted: true')
    expect(result.content).toContain('# Hello')
  })

  it('falls back to next provider when first is retryable', async () => {
    const result: any = await WebFetchTool.call(
      { url: 'https://x.com' },
      {
        cwd: '',
        sessionId: 't',
        services: {
          webFetch: {
            __testProviders: [
              makeProvider(
                {
                  ok: false,
                  retryable: true,
                  message: 'jina 429',
                },
                'jina',
              ),
              makeProvider(
                {
                  ok: true,
                  content: 'Fallback content',
                  metadata: {
                    finalUrl: 'https://x.com',
                    contentType: 'text/html',
                    contentLength: 15,
                    provider: 'local',
                    extracted: true,
                  },
                },
                'local',
              ),
            ],
          },
        },
      } as any,
    )

    expect(result.is_error).toBe(false)
    expect(result.content).toContain('Provider: local')
    expect(result.content).toContain('Fallback content')
  })

  it('returns error when all providers fail retryable', async () => {
    const result: any = await WebFetchTool.call(
      { url: 'https://x.com' },
      {
        cwd: '',
        sessionId: 't',
        services: {
          webFetch: {
            __testProviders: [
              makeProvider(
                { ok: false, retryable: true, message: 'jina 429' },
                'jina',
              ),
              makeProvider(
                { ok: false, retryable: true, message: 'local timeout' },
                'local',
              ),
            ],
          },
        },
      } as any,
    )

    expect(result.is_error).toBe(true)
    expect(result.content).toContain('jina 429')
    expect(result.content).toContain('local timeout')
  })

  it('stops chain immediately on non-retryable', async () => {
    const localCalled = vi.fn()
    const result: any = await WebFetchTool.call(
      { url: 'https://x.com' },
      {
        cwd: '',
        sessionId: 't',
        services: {
          webFetch: {
            __testProviders: [
              makeProvider(
                { ok: false, retryable: false, message: '404 not found' },
                'jina',
              ),
              {
                name: 'local',
                fetch: async () => {
                  localCalled()
                  return { ok: true, content: 'should not happen', metadata: {} }
                },
              },
            ],
          },
        },
      } as any,
    )

    expect(result.is_error).toBe(true)
    expect(localCalled).not.toHaveBeenCalled()
    expect(result.content).toContain('404 not found')
  })

  it('passes format and maxChars to provider', async () => {
    let capturedOpts: any
    const result: any = await WebFetchTool.call(
      { url: 'https://x.com', format: 'text', maxChars: 500 },
      {
        cwd: '',
        sessionId: 't',
        services: {
          webFetch: {
            __testProviders: [
              {
                name: 'fake',
                fetch: async (opts: any) => {
                  capturedOpts = opts
                  return {
                    ok: true,
                    content: 'text',
                    metadata: {
                      finalUrl: opts.url,
                      contentType: 'text/plain',
                      contentLength: 4,
                      provider: 'fake',
                      extracted: false,
                    },
                  }
                },
              },
            ],
          },
        },
      } as any,
    )

    expect(capturedOpts.format).toBe('text')
    expect(capturedOpts.maxChars).toBe(500)
    expect(result.is_error).toBe(false)
  })
})

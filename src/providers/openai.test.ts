import { describe, it, expect, vi, afterEach } from 'vitest'
import { OpenAIProvider } from './openai.js'
import { createProvider } from './index.js'
import type { CreateMessageParams } from './types.js'

/**
 * issue #142: pin the actual serialized HTTP request bodies for the
 * maxTokens limit field. OpenAI deprecated `max_tokens` in favor of
 * `max_completion_tokens`; the SDK must default to the new field and keep
 * an explicit legacy compatibility mode for older OpenAI-compatible
 * endpoints. Anthropic's separate max_tokens is out of scope.
 */

function makeParams(overrides: Record<string, unknown> = {}): CreateMessageParams {
  return {
    model: 'auto',
    maxTokens: 1024,
    system: 'Reply briefly.',
    messages: [{ role: 'user', content: '请用一句中文解释模型路由。' }],
    ...overrides,
  } as CreateMessageParams
}

const SUCCESS_JSON = {
  id: 'chatcmpl-test',
  model: 'auto',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
}

const SUCCESS_SSE = [
  'data: {"id":"chatcmpl-test","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"}}]}',
  '',
  'data: {"id":"chatcmpl-test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
  '',
  'data: [DONE]',
  '',
  '',
].join('\n')

type FetchCall = { url: string; body: Record<string, any> }

/** Stub global fetch with a response sequence; returns captured request bodies. */
function stubFetch(responses: Array<{ status: number; body?: string; json?: unknown }>): FetchCall[] {
  const calls: FetchCall[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
    calls.push({ url, body: JSON.parse(init.body) })
    const r = responses[calls.length - 1] ?? responses[responses.length - 1]
    if (r.json !== undefined) {
      return new Response(JSON.stringify(r.json), {
        status: r.status,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(r.body ?? '', { status: r.status })
  }))
  return calls
}

afterEach(() => vi.unstubAllGlobals())

describe('OpenAIProvider maxTokens serialization (issue #142)', () => {
  it('defaults to max_completion_tokens (and omits max_tokens) in non-streaming requests', async () => {
    const calls = stubFetch([{ status: 200, json: SUCCESS_JSON }])
    const provider = new OpenAIProvider({ apiKey: 'k' })

    await provider.createMessage(makeParams())

    expect(calls).toHaveLength(1)
    expect(calls[0].body.max_completion_tokens).toBe(1024)
    expect('max_tokens' in calls[0].body).toBe(false)
  })

  it('defaults to max_completion_tokens in streaming requests', async () => {
    const calls = stubFetch([{ status: 200, body: SUCCESS_SSE }])
    const provider = new OpenAIProvider({ apiKey: 'k' })

    for await (const _ of provider.createMessageStream(makeParams())) { /* drain */ }

    expect(calls).toHaveLength(1)
    expect(calls[0].body.max_completion_tokens).toBe(1024)
    expect('max_tokens' in calls[0].body).toBe(false)
    expect(calls[0].body.stream).toBe(true)
  })

  it('image-fallback retry carries max_completion_tokens (request reconstruction path)', async () => {
    const calls = stubFetch([
      { status: 400, body: '{"error":{"message":"image input is not supported"}}' },
      { status: 200, json: SUCCESS_JSON },
    ])
    const provider = new OpenAIProvider({ apiKey: 'k' })
    const params = makeParams({
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          { type: 'text', text: 'what is this?' },
        ],
      }],
    })

    await provider.createMessage(params)

    expect(calls).toHaveLength(2)
    for (const call of calls) {
      expect(call.body.max_completion_tokens).toBe(1024)
      expect('max_tokens' in call.body).toBe(false)
    }
  })

  it('legacy compatibility mode sends only max_tokens with the same value (non-streaming + streaming)', async () => {
    const calls = stubFetch([{ status: 200, json: SUCCESS_JSON }, { status: 200, body: SUCCESS_SSE }])
    const provider = new OpenAIProvider({ apiKey: 'k', legacyMaxTokens: true })

    await provider.createMessage(makeParams())
    for await (const _ of provider.createMessageStream(makeParams())) { /* drain */ }

    expect(calls).toHaveLength(2)
    for (const call of calls) {
      expect(call.body.max_tokens).toBe(1024)
      expect('max_completion_tokens' in call.body).toBe(false)
    }
  })

  it('unrelated 400 errors do not trigger a field-switch retry (exactly one request)', async () => {
    const calls = stubFetch([{ status: 400, body: '{"error":{"message":"unsupported_request"}}' }])
    const provider = new OpenAIProvider({ apiKey: 'k' })

    await expect(provider.createMessage(makeParams())).rejects.toThrow('OpenAI API error: 400')

    expect(calls).toHaveLength(1)
  })

  it('legacyMaxTokens reaches the provider through createProvider (factory wiring)', async () => {
    const calls = stubFetch([{ status: 200, json: SUCCESS_JSON }])
    const provider = createProvider('openai-completions', { apiKey: 'k', legacyMaxTokens: true })

    await provider.createMessage(makeParams())

    expect(calls).toHaveLength(1)
    expect(calls[0].body.max_tokens).toBe(1024)
    expect('max_completion_tokens' in calls[0].body).toBe(false)
  })

  it('legacy mode + image fallback: the reconstruction retry also sends only max_tokens', async () => {
    const calls = stubFetch([
      { status: 400, body: '{"error":{"message":"image input is not supported"}}' },
      { status: 200, json: SUCCESS_JSON },
    ])
    const provider = new OpenAIProvider({ apiKey: 'k', legacyMaxTokens: true })
    const params = makeParams({
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          { type: 'text', text: 'what is this?' },
        ],
      }],
    })

    await provider.createMessage(params)

    expect(calls).toHaveLength(2)
    for (const call of calls) {
      expect(call.body.max_tokens).toBe(1024)
      expect('max_completion_tokens' in call.body).toBe(false)
    }
  })
})

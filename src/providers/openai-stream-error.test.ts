import { describe, it, expect, vi, afterEach } from 'vitest'
import { OpenAIProvider } from './openai.js'
import type { CreateMessageParams } from './types.js'

/**
 * issue #174: the streaming adapter must surface SSE error payloads and a
 * premature EOF as failed operations instead of emitting the same `done`
 * event as a normally terminated stream.
 */

function makeParams(overrides: Partial<CreateMessageParams> = {}): CreateMessageParams {
  return {
    model: 'auto',
    maxTokens: 1024,
    system: 'Reply briefly.',
    messages: [{ role: 'user', content: 'hello' }],
    ...overrides,
  } as CreateMessageParams
}

/** Serve one SSE body (frames joined with blank lines) from a stubbed fetch. */
function stubSSE(frames: Array<unknown>, opts: { requestId?: string } = {}): void {
  const body = frames
    .map((f) => `data: ${typeof f === 'string' ? f : JSON.stringify(f)}\n\n`)
    .join('')
  const headers: Record<string, string> = { 'Content-Type': 'text/event-stream' }
  if (opts.requestId) headers['x-request-id'] = opts.requestId
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200, headers })))
}

async function drain(gen: AsyncGenerator<any>): Promise<{ chunks: any[]; error: any }> {
  const chunks: any[] = []
  let error: any
  try {
    for await (const chunk of gen) chunks.push(chunk)
  } catch (err) {
    error = err
  }
  return { chunks, error }
}

const CONTENT_FRAME = {
  id: 'chatcmpl-test',
  choices: [{ index: 0, delta: { content: 'Partial answer' }, finish_reason: null }],
}
const FINISH_FRAME = {
  id: 'chatcmpl-test',
  choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
}
const USAGE_FRAME = {
  id: 'chatcmpl-test',
  choices: [],
  usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
}

afterEach(() => vi.unstubAllGlobals())

describe('OpenAIProvider createMessageStream SSE error handling (issue #174)', () => {
  it('keeps a valid terminal stream (finish_reason + [DONE]) completing with done', async () => {
    stubSSE([CONTENT_FRAME, FINISH_FRAME, '[DONE]'])
    const provider = new OpenAIProvider({ apiKey: 'k' })

    const { chunks, error } = await drain(provider.createMessageStream(makeParams()))

    expect(error).toBeUndefined()
    expect(chunks.filter((c) => c.type === 'text').map((c) => c.delta)).toEqual(['Partial answer'])
    expect(chunks.at(-1)).toEqual({ type: 'done', index: -1 })
  })

  it('accepts finish_reason without [DONE] as terminal (gateways that close early)', async () => {
    stubSSE([CONTENT_FRAME, FINISH_FRAME])
    const provider = new OpenAIProvider({ apiKey: 'k' })

    const { chunks, error } = await drain(provider.createMessageStream(makeParams()))

    expect(error).toBeUndefined()
    expect(chunks.at(-1)).toEqual({ type: 'done', index: -1 })
  })

  it('keeps usage-only chunks before completion working', async () => {
    stubSSE([CONTENT_FRAME, FINISH_FRAME, USAGE_FRAME, '[DONE]'])
    const provider = new OpenAIProvider({ apiKey: 'k' })

    const { chunks, error } = await drain(provider.createMessageStream(makeParams()))

    expect(error).toBeUndefined()
    const usage = chunks.find((c) => c.type === 'usage')
    expect(usage!.usage).toMatchObject({ input_tokens: 7, output_tokens: 3, totalInputTokens: 7 })
    expect(chunks.at(-1)).toEqual({ type: 'done', index: -1 })
  })

  it('throws on an SSE error frame, preserving code/message and request id', async () => {
    stubSSE(
      [
        CONTENT_FRAME,
        { error: { code: 'upstream_unavailable', message: 'Provider service unavailable' } },
      ],
      { requestId: 'req-123' },
    )
    const provider = new OpenAIProvider({ apiKey: 'k' })

    const { chunks, error } = await drain(provider.createMessageStream(makeParams()))

    // Partial text already received is preserved...
    expect(chunks.filter((c) => c.type === 'text').map((c) => c.delta)).toEqual(['Partial answer'])
    // ...but the operation fails instead of completing.
    expect(chunks.some((c) => c.type === 'done')).toBe(false)
    expect(error).toBeDefined()
    expect(error.message).toContain('upstream_unavailable')
    expect(error.message).toContain('Provider service unavailable')
    expect(error.message).toContain('req-123')
    expect(error.status).toBe(200)
    expect(error.error).toEqual({ code: 'upstream_unavailable', message: 'Provider service unavailable' })
    expect(error.requestId).toBe('req-123')
  })

  it('surfaces an SSE error frame that arrives before any content as a failure', async () => {
    stubSSE([{ error: { type: 'server_error', message: 'boom' } }])
    const provider = new OpenAIProvider({ apiKey: 'k' })

    const { chunks, error } = await drain(provider.createMessageStream(makeParams()))

    expect(chunks).toEqual([])
    expect(error).toBeDefined()
    expect(error.message).toContain('server_error')
    expect(error.message).toContain('boom')
  })

  it('throws an interrupted-stream error on premature EOF (no [DONE]/finish_reason)', async () => {
    stubSSE([CONTENT_FRAME])
    const provider = new OpenAIProvider({ apiKey: 'k' })

    const { chunks, error } = await drain(provider.createMessageStream(makeParams()))

    expect(chunks.filter((c) => c.type === 'text').map((c) => c.delta)).toEqual(['Partial answer'])
    expect(chunks.some((c) => c.type === 'done')).toBe(false)
    expect(error).toBeDefined()
    expect(error.message).toContain('ended without completion')
    expect(error.streamInterrupted).toBe(true)
  })

  it('does not throw on an empty stream when the caller aborted', async () => {
    stubSSE([])
    const controller = new AbortController()
    controller.abort()
    const provider = new OpenAIProvider({ apiKey: 'k' })

    const { chunks, error } = await drain(
      provider.createMessageStream(makeParams({ signal: controller.signal })),
    )

    // Caller-initiated cancellation keeps the legacy graceful finish.
    expect(error).toBeUndefined()
    expect(chunks.at(-1)).toEqual({ type: 'done', index: -1 })
  })
})
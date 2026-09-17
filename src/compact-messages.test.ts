import { describe, expect, it } from 'vitest'
import * as sdk from './index.js'
import { compactMessages, compactMessagesStream, type CompactMessagesResult } from './compact-messages.js'
import { createAutoCompactState } from './utils/compact.js'
import type { LLMProvider, NormalizedMessageParam, StreamChunk } from './providers/types.js'
import type { SDKCompactMessage } from './types.js'

function buildConversation(queries: number): NormalizedMessageParam[] {
  const messages: NormalizedMessageParam[] = []
  for (let index = 1; index <= queries; index++) {
    messages.push({ role: 'user', content: `user-${index}` })
    messages.push({ role: 'assistant', content: `assistant-${index}` })
  }
  messages.push({ role: 'user', content: 'final-user' })
  return messages
}

function provider(summary = 'safe summary'): LLMProvider {
  return {
    apiType: 'anthropic-messages',
    async createMessage() {
      return {
        content: [{ type: 'text', text: summary }],
        stopReason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1, totalInputTokens: 1 },
      }
    },
  }
}

describe('compactMessages', () => {
  it('preserves the requested recent tail and returns coherent state', async () => {
    const messages = buildConversation(5)
    const state = {
      ...createAutoCompactState(),
      lastInputTokens: 100_000,
      lastOutputTokens: 500,
    }

    const result = await compactMessages({
      provider: provider(),
      model: 'test-model',
      messages,
      state,
      protectedQueries: 2,
    })

    expect(result.compacted).toBe(true)
    expect(result.summary).toBe('safe summary')
    expect(result.state.lastInputTokens).toBe(0)
    expect(result.state.lastOutputTokens).toBe(0)

    const text = JSON.stringify(result.messages)
    expect(text).not.toContain('user-1')
    expect(text).not.toContain('assistant-3')
    expect(text).toContain('user-4')
    expect(text).toContain('assistant-5')
    expect(text).toContain('final-user')
  })

  it('propagates stream cancellation to the provider', async () => {
    const cleanup = { ran: false }
    const cancellableProvider: LLMProvider = {
      apiType: 'anthropic-messages',
      async createMessage() { throw new Error('not used') },
      async *createMessageStream(): AsyncGenerator<StreamChunk> {
        try {
          yield { type: 'text', index: 0, delta: 'first' } as StreamChunk
          yield { type: 'text', index: 0, delta: 'second' } as StreamChunk
        } finally {
          cleanup.ran = true
        }
      },
    }

    const stream = compactMessagesStream({
      provider: cancellableProvider,
      model: 'test-model',
      messages: buildConversation(5),
      state: createAutoCompactState(),
      protectedQueries: 2,
    })

    expect((await stream.next()).value).toMatchObject({ phase: 'start' })
    expect((await stream.next()).value).toMatchObject({ phase: 'progress' })
    await stream.return(undefined as never)
    expect(cleanup.ran).toBe(true)
  })

  it('does not expose hazardous raw compaction helpers from the package root', () => {
    const exports = sdk as Record<string, unknown>
    expect(exports.compactMessages).toBeTypeOf('function')
    expect(exports.compactMessagesStream).toBeTypeOf('function')
    expect(exports.compactConversation).toBeUndefined()
    expect(exports.compactConversationStream).toBeUndefined()
    expect(exports.compactConversationWithProtectedTail).toBeUndefined()
  })
})

describe('compact error propagation (#109)', () => {
  /** Provider that fails on BOTH code paths with the same message. */
  function failingProvider(message: string): LLMProvider {
    return {
      apiType: 'anthropic-messages',
      async createMessage() { throw new Error(message) },
      async *createMessageStream(): AsyncGenerator<StreamChunk> {
        throw new Error(message)
      },
    }
  }

  it('provider failure propagates the sanitized error through the stream wrapper', async () => {
    const events: SDKCompactMessage[] = []
    const gen = compactMessagesStream({
      provider: failingProvider('OpenAI API error: 429'),
      model: 'test-model',
      messages: buildConversation(5),
      state: createAutoCompactState(),
      protectedQueries: 2,
    })
    let result: CompactMessagesResult | undefined
    while (true) {
      const next = await gen.next()
      if (next.done) { result = next.value; break }
      events.push(next.value)
    }
    expect(result!.compacted).toBe(false)
    expect(result!.error).toContain('429')
    const end = events.at(-1)
    expect(end?.type).toBe('compact')
    expect(end?.phase).toBe('end')
    expect(end?.error).toContain('429')
  })

  it('nothing-to-compact (identity) leaves error undefined', async () => {
    const result = await compactMessages({
      provider: provider(),
      model: 'test-model',
      messages: buildConversation(3),
      state: createAutoCompactState(),
      protectedQueries: 10, // ≥ all queries → cutoff 0 → identity return
    })
    expect(result.compacted).toBe(false)
    expect(result.error).toBeUndefined()
  })

  it('success leaves error undefined', async () => {
    const result = await compactMessages({
      provider: provider(),
      model: 'test-model',
      messages: buildConversation(5),
      state: createAutoCompactState(),
      protectedQueries: 2,
    })
    expect(result.compacted).toBe(true)
    expect(result.error).toBeUndefined()
  })
})

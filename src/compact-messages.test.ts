import { describe, expect, it } from 'vitest'
import * as sdk from './index.js'
import { compactMessages, compactMessagesStream } from './compact-messages.js'
import { createAutoCompactState } from './utils/compact.js'
import type { LLMProvider, NormalizedMessageParam, StreamChunk } from './providers/types.js'

function buildConversation(turns: number): NormalizedMessageParam[] {
  const messages: NormalizedMessageParam[] = []
  for (let index = 1; index <= turns; index++) {
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
      protectedTurns: 2,
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
      protectedTurns: 2,
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

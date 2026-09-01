import { describe, expect, it, vi } from 'vitest'

let mockCreateImpl: any

// Mock the Anthropic SDK
vi.mock('@anthropic-ai/sdk', () => {
  // Structured instance shape: the SDK's Anthropic client exposes
  // `messages.create`, which the provider awaits as an async iterable.
  const MockAnthropic = function (this: { messages: { create: () => unknown } }) {
    this.messages = {
      create: () => mockCreateImpl,
    }
  }
  return {
    default: MockAnthropic,
  }
})

describe('AnthropicProvider createMessageStream SSE error handling', () => {
  it('throws on SSE error event with error.type preserved', async () => {
    mockCreateImpl = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'message_start', message: { usage: { input_tokens: 10 } } }
        yield { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }
      },
    }

    const { AnthropicProvider } = await import('./anthropic.js')

    const provider = new AnthropicProvider({ apiKey: 'test' })
    const gen = provider.createMessageStream!({
      model: 'claude-test',
      maxTokens: 100,
      system: 'test',
      messages: [{ role: 'user', content: 'hello' }],
    })

    const chunks: any[] = []
    let thrownError: any
    try {
      for await (const chunk of gen) {
        chunks.push(chunk)
      }
    } catch (err) {
      thrownError = err
    }

    expect(chunks).toHaveLength(1) // message_start usage event
    expect(chunks[0].type).toBe('usage')
    expect(thrownError).toBeDefined()
    expect(thrownError.message).toContain('overloaded_error')
    expect(thrownError.error?.type).toBe('overloaded_error')
  })
})

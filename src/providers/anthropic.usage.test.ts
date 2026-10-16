import { describe, expect, it, vi } from 'vitest'

let mockCreateImpl: any

vi.mock('@anthropic-ai/sdk', () => {
  const MockAnthropic = function (this: { messages: { create: () => unknown } }) {
    this.messages = { create: () => mockCreateImpl }
  }
  return { default: MockAnthropic }
})

// #149 T2: the Anthropic seam total must equal input + cache_read +
// cache_creation — the same 550k as the OpenAI shape (T1), proving the two
// adapters normalize to one contract with cache counted exactly once.
describe('usage normalization equivalence (#149)', () => {
  it('seam totalInputTokens = input + cache_read + cache_creation', async () => {
    mockCreateImpl = Promise.resolve({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 15_000, output_tokens: 100, cache_read_input_tokens: 535_000, cache_creation_input_tokens: 0 },
    })

    const { AnthropicProvider } = await import('./anthropic.js')
    const provider = new AnthropicProvider({ apiKey: 'test' })

    const res = await provider.createMessage({
      model: 'claude-test', maxTokens: 100, system: 'test',
      messages: [{ role: 'user', content: 'hello' }],
    })

    expect(res.usage.totalInputTokens).toBe(550_000)
    expect(res.usage.input_tokens).toBe(15_000) // Anthropic input EXCLUDES cache
  })
})

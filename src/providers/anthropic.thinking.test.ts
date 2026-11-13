import { describe, expect, it, vi } from 'vitest'

let mockCreateImpl: any
let capturedParams: any

// Capture-style mock (unlike anthropic.usage.test.ts, which ignores the
// request): assert what the provider ACTUALLY sends for each thinking value.
vi.mock('@anthropic-ai/sdk', () => {
  const MockAnthropic = function (this: { messages: { create: (p: unknown) => unknown } }) {
    this.messages = {
      create: (p: unknown) => { capturedParams = p; return mockCreateImpl },
    }
  }
  return { default: MockAnthropic }
})

const PARAMS = { model: 'claude-test', maxTokens: 100, system: 't', messages: [{ role: 'user', content: 'hi' }] }

async function createWith(thinking: unknown) {
  mockCreateImpl = Promise.resolve({
    content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: {},
  })
  const { AnthropicProvider } = await import('./anthropic.js')
  const provider = new AnthropicProvider({ apiKey: 'test' })
  await provider.createMessage({ ...PARAMS, thinking } as any)
  return capturedParams
}

async function createStreamWith(thinking: unknown) {
  mockCreateImpl = {
    async *[Symbol.asyncIterator]() {
      yield { type: 'message_start', message: { usage: { input_tokens: 1 } } }
    },
  }
  const { AnthropicProvider } = await import('./anthropic.js')
  const provider = new AnthropicProvider({ apiKey: 'test' })
  const gen = provider.createMessageStream!({ ...PARAMS, thinking } as any)
  await gen.next()  // triggers the client create call
  return capturedParams
}

// #166: disabled → native {type:'disabled'}; enabled without budget →
// MIN_THINKING_BUDGET_TOKENS (1024, Anthropic minimum); adaptive → no field.
describe('thinking mapping (#166)', () => {
  const CASES: Array<{ name: string; thinking: any; expected: any }> = [
    { name: 'enabled with budget', thinking: { type: 'enabled', budget_tokens: 4096 }, expected: { type: 'enabled', budget_tokens: 4096 } },
    { name: 'enabled without budget defaults to 1024', thinking: { type: 'enabled' }, expected: { type: 'enabled', budget_tokens: 1024 } },
    { name: 'disabled is sent natively', thinking: { type: 'disabled' }, expected: { type: 'disabled' } },
    { name: 'adaptive sends no thinking field', thinking: { type: 'adaptive' }, expected: undefined },
  ]

  for (const c of CASES) {
    it(`non-streaming: ${c.name}`, async () => {
      const params = await createWith(c.thinking)
      expect(params.thinking).toEqual(c.expected)
    })
    it(`streaming: ${c.name}`, async () => {
      const params = await createStreamWith(c.thinking)
      expect(params.thinking).toEqual(c.expected)
    })
  }
})

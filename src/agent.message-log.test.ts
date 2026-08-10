import { describe, it, expect } from 'vitest'
import { Agent } from './agent.js'
import type {
  LLMProvider,
  CreateMessageParams,
  CreateMessageResponse,
} from './providers/types.js'

/**
 * Minimal LLMProvider that returns a single static text response without
 * making any network calls. Pattern borrowed from
 * src/utils/session-turns-integration.test.ts:24 (RecordingProvider).
 */
class FakeProvider implements LLMProvider {
  readonly apiType = 'anthropic-messages' as const

  async createMessage(
    _params: CreateMessageParams,
  ): Promise<CreateMessageResponse> {
    return {
      content: [{ type: 'text', text: 'mock response' }],
      stopReason: 'end_turn',
      usage: {
        input_tokens: 5,
        output_tokens: 3,
        totalInputTokens: 5,
      },
    }
  }
}

/**
 * Build an Agent with persistSession disabled (no disk writes) and
 * permissionMode bypassed. Monkey-patches the private `provider` field
 * so `prompt()` uses FakeProvider instead of hitting a real LLM.
 */
function makeAgent(): Agent {
  const agent = new Agent({
    apiKey: 'fake-key',
    persistSession: false,
    permissionMode: 'bypassPermissions',
    // Disable SnapshotEngine: these tests run concurrently and would all
    // `git init --bare` into the same shared ~/.agents/snapshot/<hash> dir,
    // racing on git's config lock. Not under test here.
    enableFileRevert: false,
  })
  ;(agent as any).provider = new FakeProvider()
  return agent
}

describe('Agent message log', () => {
  it('exposes getMessageLog() returning the audit log array', async () => {
    const agent = makeAgent()
    await agent.prompt('hi')

    expect(typeof agent.getMessageLog).toBe('function')
    const log = agent.getMessageLog()
    expect(Array.isArray(log)).toBe(true)
    expect(log.length).toBeGreaterThan(0)
  })

  it('emits user message BEFORE assistant response (chronological order)', async () => {
    const agent = makeAgent()
    await agent.prompt('hi')

    const log = agent.getMessageLog()
    const roles = log.map((m) => m.type)
    const userIdx = roles.indexOf('user')
    const assistantIdx = roles.indexOf('assistant')

    expect(userIdx).toBeGreaterThanOrEqual(0)
    expect(assistantIdx).toBeGreaterThanOrEqual(0)
    // Order regression: user prompt must precede its assistant response.
    // Fails on current code because user push happens in `finally` after
    // all assistant events have already been pushed.
    expect(userIdx).toBeLessThan(assistantIdx)
  })

  it('does not expose legacy getMessages() (no silent alias)', () => {
    const agent = makeAgent()
    expect((agent as any).getMessages).toBeUndefined()
  })
})

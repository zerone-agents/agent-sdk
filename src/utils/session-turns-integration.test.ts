import { describe, expect, it } from 'vitest'
import { QueryEngine } from '../engine.js'
import type {
  LLMProvider,
  CreateMessageParams,
  CreateMessageResponse,
  NormalizedMessageParam,
} from '../providers/types.js'
import type { QueryEngineConfig, CanUseToolFn } from '../types.js'
import { SkillRegistry } from '../skills/index.js'

/**
 * Integration test: verifies that the `maxSessionTurns` engine wiring works
 * end-to-end. The engine must:
 *   - send only the last N conversation rounds to the LLM provider (truncated)
 *   - keep the FULL transcript in engine.getMessages() (not truncated)
 *
 * Spec: "create agent with maxSessionTurns: 2, run 5 queries, verify session
 * transcript has all messages but API calls only received last 2 rounds."
 */

/** A minimal recording provider. Captures the `messages` array it receives on
 * each createMessage() call and returns a plain text response so the agentic
 * loop completes in a single turn (no tool_use). */
class RecordingProvider implements LLMProvider {
  readonly apiType = 'anthropic-messages' as const
  /** Deep-cloned snapshot of the messages array passed on each API call. */
  calls: NormalizedMessageParam[][] = []

  async createMessage(
    params: CreateMessageParams,
  ): Promise<CreateMessageResponse> {
    // Deep clone so later engine mutations don't alter our recorded snapshot.
    this.calls.push(
      params.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })) as NormalizedMessageParam[],
    )

    // Derive a deterministic reply from the last user text so we can assert
    // which round the assistant response belongs to.
    const lastUserText = extractLastUserText(params.messages)
    return {
      content: [{ type: 'text', text: `Response to ${lastUserText}` }],
      stopReason: 'end_turn',
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        totalInputTokens: 10,
      },
    }
  }
}

function extractLastUserText(messages: NormalizedMessageParam[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'user') continue
    if (typeof m.content === 'string') return m.content
    if (Array.isArray(m.content)) {
      const textBlock = m.content.find(
        (b: any) => b.type === 'text',
      ) as { type: 'text'; text: string } | undefined
      if (textBlock) return textBlock.text
    }
  }
  return ''
}

/** Drain an async generator to completion, ignoring yielded values. */
async function drain(gen: AsyncGenerator<unknown>): Promise<void> {
  for await (const _ of gen) {
    /* drain */
  }
}

function buildConfig(
  provider: LLMProvider,
  overrides: Partial<QueryEngineConfig> = {},
): QueryEngineConfig {
  const canUseTool: CanUseToolFn = async () => ({ behavior: 'allow' })
  return {
    env: {
      provider,
      model: 'test-model',
      maxTokens: 1024,
      cwd: process.cwd(),
      customTools: [],
      mcpTools: [],
      skillRegistry: new SkillRegistry(),
    },
    resolved: {
      definition: { description: 'test', prompt: 'test prompt' },
      tools: [],
      skills: [],
    },
    maxTurns: 1,
    canUseTool,
    includePartialMessages: false,
    agentId: 'test-agent',
    maxSessionTurns: 2,
    ...overrides,
  }
}

describe('maxSessionTurns engine wiring (integration)', () => {
  it('truncates API messages to last 2 rounds while keeping full transcript', async () => {
    const provider = new RecordingProvider()
    const engine = new QueryEngine(buildConfig(provider))

    // Run 4 rounds: each submitMessage adds a user msg + assistant response.
    for (let i = 1; i <= 4; i++) {
      await drain(engine.submitMessage(`Question ${i}`))
    }

    // --- Assert: provider received one API call per round ---
    expect(provider.calls).toHaveLength(4)

    // --- Assert: the LAST API call only received the last 2 rounds ---
    //
    // Truncation happens BEFORE the current round's assistant reply exists.
    // With maxSessionTurns=2, the 4th call should receive:
    //   [user3, assistant3, user4]  (round 3 complete + round 4 partial)
    const lastCall = provider.calls[3]
    expect(lastCall).toHaveLength(3)
    expect(lastCall.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(extractLastUserText([lastCall[0]])).toBe('Question 3')
    expect(extractLastUserText([lastCall[2]])).toBe('Question 4')

    // --- Assert: the 3rd API call was also truncated to last 2 rounds ---
    //   [user2, assistant2, user3]  — note Question 1 is GONE, proving truncation
    const thirdCall = provider.calls[2]
    expect(thirdCall).toHaveLength(3)
    expect(extractLastUserText([thirdCall[0]])).toBe('Question 2')
    expect(extractLastUserText([thirdCall[2]])).toBe('Question 3')

    // --- Assert: no truncation when rounds <= maxSessionTurns ---
    // 2nd call: 2 user msgs → 2 turns → 2 <= 2 → full history sent:
    //   [user1, assistant1, user2]
    const secondCall = provider.calls[1]
    expect(secondCall).toHaveLength(3)
    expect(extractLastUserText([secondCall[0]])).toBe('Question 1')

    // 1st call: single user message, no truncation possible
    const firstCall = provider.calls[0]
    expect(firstCall).toHaveLength(1)
    expect(extractLastUserText(firstCall)).toBe('Question 1')

    // --- Assert: engine.getMessages() returns the FULL, untruncated history ---
    // 4 rounds × (user + assistant) = 8 messages.
    const fullHistory = engine.getMessages()
    expect(fullHistory).toHaveLength(8)
    expect(fullHistory.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
      'assistant',
    ])
    // Sanity: first user + last user are both present (not dropped)
    expect(extractLastUserText([fullHistory[0]])).toBe('Question 1')
    expect(extractLastUserText([fullHistory[6]])).toBe('Question 4')
  })

  it('does not truncate when maxSessionTurns is unset', async () => {
    const provider = new RecordingProvider()
    const engine = new QueryEngine(buildConfig(provider, { maxSessionTurns: undefined }))

    for (let i = 1; i <= 4; i++) {
      await drain(engine.submitMessage(`Question ${i}`))
    }

    expect(provider.calls).toHaveLength(4)
    // 4th call: full history = 7 messages (4 user + 3 assistant; the 4th
    // assistant hasn't been generated yet at API-call time).
    const lastCall = provider.calls[3]
    expect(lastCall).toHaveLength(7)
    expect(extractLastUserText([lastCall[0]])).toBe('Question 1')

    // Full transcript retained
    expect(engine.getMessages()).toHaveLength(8)
  })
})

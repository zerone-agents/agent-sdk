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
import { createEmptyServices } from '../tools/services.js'

/**
 * Integration test: verifies that the `maxSessionQueries` engine wiring works
 * end-to-end with halved compaction. When the conversation exceeds
 * maxSessionQueries user queries, the engine must:
 *   - summarize the older half via the LLM (an extra compaction API call)
 *   - rewrite the persistent transcript to [summary pair, ...recent half]
 *   - fall back to keeping the transcript bounded on every subsequent overflow
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
    // which query the assistant response belongs to.
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
    runtime: {
      provider,
      model: 'test-model',
      maxTokens: 1024,
      cwd: process.cwd(),
      subprocessEnv: {},
      toolServices: createEmptyServices(),
    },
    resolved: {
      definition: { description: 'test', prompt: 'test prompt' },
      tools: [],
      deferredTools: [],
      skills: [],
      services: createEmptyServices(),
      skillRegistry: new SkillRegistry(),
    },
    maxTurns: 1,
    canUseTool,
    includePartialMessages: false,
    agentId: 'test-agent',
    maxSessionQueries: 2,
    ...overrides,
  }
}

describe('maxSessionQueries engine wiring (integration)', () => {
  it('compacts the older half into a summary when rounds exceed maxSessionQueries', async () => {
    const provider = new RecordingProvider()
    const engine = new QueryEngine(buildConfig(provider))

    // Run 4 rounds: each submitMessage adds a user msg + assistant response.
    for (let i = 1; i <= 4; i++) {
      await drain(engine.submitMessage(`Question ${i}`))
    }

    // Compaction requests are single-message calls whose prompt asks for a summary.
    const isCompactionCall = (call: NormalizedMessageParam[]) =>
      call.length === 1 &&
      typeof call[0].content === 'string' &&
      call[0].content.startsWith('Please summarize')
    const compactionCalls = provider.calls.filter(isCompactionCall)
    const mainCalls = provider.calls.filter((c) => !isCompactionCall(c))

    // --- Assert: 4 main API calls (one per round) ---
    expect(mainCalls).toHaveLength(4)

    // --- Assert: compaction fired at round 3 and round 4 ---
    // After Q3 is appended, turns (3) exceed maxSessionQueries (2) → compact.
    // The summary pair counts as 1 fresh user turn, so after Q4 is appended
    // turns are 4 again → compact once more.
    expect(compactionCalls).toHaveLength(2)

    // --- Assert: the last main call starts with the summary pair ---
    // and keeps only the recent half verbatim (protectedQueries = 1 round).
    const lastCall = mainCalls[3]
    expect(lastCall[0].role).toBe('user')
    expect(lastCall[0].content).toContain('[Previous conversation summary]')
    // The raw pre-compaction turns are gone as standalone messages.
    const mainCallJson = JSON.stringify(lastCall)
    expect(mainCallJson).not.toContain('"content":"Question 1"')

    // --- Assert: early rounds ran without compaction ---
    // 1st call: single user message; 2nd call: 2 turns <= 2 → full history.
    expect(mainCalls[0]).toHaveLength(1)
    expect(extractLastUserText(mainCalls[0])).toBe('Question 1')
    expect(mainCalls[1]).toHaveLength(3)
    expect(extractLastUserText([mainCalls[1][0]])).toBe('Question 1')

    // --- Assert: persistent transcript was rewritten with the summary ---
    const history = engine.getMessages()
    expect(history[0].role).toBe('user')
    expect(history[0].content).toContain('[Previous conversation summary]')
    // Recent rounds survive verbatim in the persistent transcript.
    const historyJson = JSON.stringify(history)
    expect(historyJson).toContain('Question 4')
  })

  it('does not truncate when maxSessionQueries is unset', async () => {
    const provider = new RecordingProvider()
    const engine = new QueryEngine(buildConfig(provider, { maxSessionQueries: undefined }))

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

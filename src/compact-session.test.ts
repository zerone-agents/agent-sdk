import { describe, it, expect, afterAll } from 'vitest'
import { compactSessionStream, compactSession, type CompactSessionResult } from './compact-session.js'
import { loadSession, saveSession, deleteSession } from './session.js'
import { shouldAutoCompact, PRUNE_PROTECTED_QUERIES, PRUNE_THRESHOLD_CHARS, createAutoCompactState } from './utils/compact.js'
import type { LLMProvider, StreamChunk, NormalizedMessageParam } from './providers/types.js'

/**
 * Regression coverage for issue #46: session-level compact-and-persist.
 *
 * Scenarios (mapping to the issue's acceptance criteria):
 * 1. missing session → throws
 * 2. protected-tail preservation (recent queries structurally intact)
 * 3. coherent persistence (messageCount + token counters + summary + createdAt)
 * 4. provider failure → persisted transcript/metadata unchanged
 * 5. generator cancellation → persisted transcript unchanged
 * 6. resume after compaction does not auto-compact again (stale usage cleared)
 * 7. start/progress/end event stream compatibility
 * 8. protectedQueries option + same default as Agent.compactStream()
 */

/** Non-streaming mock provider returning a fixed summary. */
function makeNonStreamingProvider(): LLMProvider {
  return {
    apiType: 'anthropic-messages',
    async createMessage() {
      return {
        content: [{ type: 'text', text: 'SUMMARY: goal, instructions, discoveries, accomplished, files.' }],
        stopReason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1, totalInputTokens: 1 },
      }
    },
  }
}

/** Streaming mock provider yielding the summary in deltas. */
function makeStreamingProvider(): LLMProvider {
  return {
    apiType: 'anthropic-messages',
    async createMessage() { throw new Error('not used') },
    async *createMessageStream(): AsyncGenerator<StreamChunk> {
      yield { type: 'text', index: 0, delta: 'SUMMARY-part-1 ' } as StreamChunk
      yield { type: 'text', index: 0, delta: 'SUMMARY-part-2' } as StreamChunk
      yield { type: 'done', index: -1 } as StreamChunk
    },
  }
}

/** Provider that always fails — simulates provider failure. */
function makeFailingProvider(): LLMProvider {
  return {
    apiType: 'anthropic-messages',
    async createMessage() { throw new Error('provider exploded') },
  }
}

/**
 * Streaming provider that records cleanup in `finally` — proves whether
 * cancellation of the public stream propagates all the way down (review #47
 * round 2 P1).
 */
function makeCancellableProvider(cleanup: { ran: boolean }): LLMProvider {
  return {
    apiType: 'anthropic-messages',
    async createMessage() { throw new Error('not used') },
    async *createMessageStream(): AsyncGenerator<StreamChunk> {
      try {
        yield { type: 'text', index: 0, delta: 'delta-1 ' } as StreamChunk
        yield { type: 'text', index: 0, delta: 'delta-2' } as StreamChunk
        yield { type: 'done', index: -1 } as StreamChunk
      } finally {
        cleanup.ran = true
      }
    },
  }
}

/**
 * Build a conversation with `queries` user queries (+ assistant replies), each
 * with a distinctive content string, ending with a final user message.
 * Returns messages plus the split point: with default protectedQueries=4,
 * user query indices >= queries-6 are protected, below are summarized.
 */
function buildConversation(queries: number): NormalizedMessageParam[] {
  const messages: NormalizedMessageParam[] = []
  for (let i = 1; i <= queries; i++) {
    messages.push({ role: 'user', content: `user query ${i} question about topic-${i}` })
    messages.push({ role: 'assistant', content: `assistant answer ${i}` })
  }
  // Final user message (always the lastMsg, always protected)
  messages.push({ role: 'user', content: 'final user message' })
  return messages
}

const SESSIONS: string[] = []

function freshSessionId(label: string): string {
  const id = `compact-session-test-${label}-${crypto.randomUUID()}`
  SESSIONS.push(id)
  return id
}

/**
 * One query = [user prompt, assistant tool_use, user tool_result wrapper].
 * The tool_result payload is oversized (PRUNE_THRESHOLD_CHARS + 1) so that
 * compaction-time pruning (issue #86) must clear it when it falls outside
 * the protected tool-result window.
 */
function bigToolRound(prompt: string, id: string): NormalizedMessageParam[] {
  return [
    { role: 'user', content: prompt } as NormalizedMessageParam,
    { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: {} }] } as unknown as NormalizedMessageParam,
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'x'.repeat(PRUNE_THRESHOLD_CHARS + 1) }] } as unknown as NormalizedMessageParam,
  ]
}

/**
 * Persist a session of `n` big-tool rounds (oversized tool results) plus a
 * final assistant message — the fixture for tool-result pruning at
 * compaction. Returns the session id.
 */
async function seedBigToolSession(n: number): Promise<string> {
  const sid = freshSessionId('big-tool')
  const messages: NormalizedMessageParam[] = []
  for (let i = 1; i <= n; i++) messages.push(...bigToolRound(`query ${i}`, `id-${i}`))
  messages.push({ role: 'assistant', content: 'final' } as NormalizedMessageParam)
  await saveSession(sid, messages, { cwd: '/tmp/project', model: 'test-model' })
  return sid
}

/** Drain a compactSessionStream and return its final result. */
async function drainSession(stream: ReturnType<typeof compactSessionStream>): Promise<CompactSessionResult> {
  while (true) {
    const next = await stream.next()
    if (next.done) return next.value
  }
}

afterAll(async () => {
  for (const id of SESSIONS) {
    await deleteSession(id).catch(() => {})
  }
})

describe('compactSessionStream (issue #46)', () => {
  it('throws when the session does not exist', async () => {
    const stream = compactSessionStream({
      sessionId: 'compact-session-test-nonexistent',
      provider: makeNonStreamingProvider(),
    })
    await expect(stream.next()).rejects.toThrow(/Session not found/)
  })

  it('preserves the protected tail structurally intact (not just inside the summary)', async () => {
    const sid = freshSessionId('tail')
    const messages = buildConversation(10)
    await saveSession(sid, messages, {
      cwd: '/tmp/project',
      model: 'test-model',
      lastInputTokens: 500_000, // would trigger auto-compact if stale
      lastOutputTokens: 546,
    })

    const result = await compactSession({
      sessionId: sid,
      provider: makeNonStreamingProvider(),
    })

    expect(result.compacted).toBe(true)
    expect(result.summary).toContain('SUMMARY')

    // Protected region: last 4 user queries of history + final message survive
    // VERBATIM. User queries 7..10 + 'final user message' must appear as-is.
    const persisted = await loadSession(sid)
    expect(persisted).not.toBeNull()
    const allText = JSON.stringify(persisted!.messages)
    for (let i = 7; i <= 10; i++) { // queries 7..10 = last 4 user queries of history
      expect(allText).toContain(`user query ${i} question about topic-${i}`)
      expect(allText).toContain(`assistant answer ${i}`)
    }
    expect(allText).toContain('final user message')

    // Summarized region: queries 1..6 survive ONLY as summary text — the
    // verbatim strings must be gone (head was replaced by the summary pair).
    expect(allText).not.toContain('user query 1 question about topic-1')
    expect(allText).not.toContain('user query 6 question about topic-6')

    // Structural shape: [summary user, summary assistant, ...protected tail..., final]
    const first = persisted!.messages[0] as { role: string; content: string }
    expect(first.role).toBe('user')
    expect(first.content).toContain('[Previous conversation summary]')
    expect((persisted!.messages.at(-1) as { content: string }).content).toBe('final user message')
  })

  it('persists one coherent update: messageCount, token counters, summary, createdAt', async () => {
    const sid = freshSessionId('coherent')
    const createdAt = new Date('2026-01-01T00:00:00Z').toISOString()
    await saveSession(sid, buildConversation(10), {
      cwd: '/tmp/project',
      model: 'test-model',
      createdAt,
      lastInputTokens: 429_962,
      lastOutputTokens: 546,
    })

    const result = await compactSession({
      sessionId: sid,
      provider: makeNonStreamingProvider(),
    })

    const persisted = await loadSession(sid)
    expect(persisted).not.toBeNull()

    // messageCount derived from the compacted messages, matches result
    expect(persisted!.metadata.messageCount).toBe(result.messages.length)
    expect(persisted!.messages).toHaveLength(result.messages.length)

    // Token counters persisted from the SAME result — zeroed by compaction.
    // This is the exact failure mode observed in Zerone App: hosts persisted
    // compacted messages while keeping stale counts.
    expect(persisted!.metadata.lastInputTokens).toBe(0)
    expect(persisted!.metadata.lastOutputTokens).toBe(0)
    expect(result.state.lastInputTokens).toBe(0)

    // Summary + still-valid metadata preserved
    expect(persisted!.metadata.summary).toBe(result.summary)
    expect(persisted!.metadata.createdAt).toBe(createdAt)
    expect(persisted!.metadata.cwd).toBe('/tmp/project')
    expect(persisted!.metadata.model).toBe('test-model')
  })

  it('leaves the persisted transcript and usage metadata unchanged on provider failure', async () => {
    const sid = freshSessionId('fail')
    const messages = buildConversation(10)
    await saveSession(sid, messages, {
      cwd: '/tmp/project',
      model: 'test-model',
      lastInputTokens: 123_456,
      lastOutputTokens: 789,
    })
    const before = await loadSession(sid)

    const result = await compactSession({
      sessionId: sid,
      provider: makeFailingProvider(),
    })

    // Unsuccessful: reported as such, nothing persisted
    expect(result.compacted).toBe(false)
    expect(result.summary).toBe('')

    const after = await loadSession(sid)
    expect(after!.messages).toEqual(before!.messages)
    expect(after!.metadata.lastInputTokens).toBe(123_456)
    expect(after!.metadata.lastOutputTokens).toBe(789)
    expect(after!.metadata.messageCount).toBe(before!.metadata.messageCount)
  })

  it('leaves the persisted transcript unchanged when the generator is cancelled mid-stream', async () => {
    const sid = freshSessionId('cancel')
    const messages = buildConversation(10)
    await saveSession(sid, messages, {
      cwd: '/tmp/project',
      model: 'test-model',
      lastInputTokens: 100_000,
      lastOutputTokens: 200,
    })
    const before = await loadSession(sid)

    const stream = compactSessionStream({
      sessionId: sid,
      provider: makeStreamingProvider(),
    })
    // Consume events PAST the synthetic start and through at least one real
    // provider `progress` delta (review #47 P2: cancelling right after start
    // never exercises mid-provider-output cancellation).
    let sawProviderProgress = false
    while (!sawProviderProgress) {
      const next = await stream.next()
      if (next.done) throw new Error('stream completed before a progress event')
      if ((next.value as { phase?: string }).phase === 'progress') {
        sawProviderProgress = true
      }
    }
    expect(sawProviderProgress).toBe(true)
    await stream.return?.(undefined as never)

    const after = await loadSession(sid)
    expect(after!.messages).toEqual(before!.messages)
    expect(after!.metadata.lastInputTokens).toBe(100_000)
    expect(after!.metadata.lastOutputTokens).toBe(200)
    expect(after!.metadata.messageCount).toBe(before!.metadata.messageCount)
    expect(after!.metadata.summary).toBeUndefined()
  })

  it('propagates cancellation to the provider generator (finally cleanup runs)', async () => {
    const sid = freshSessionId('cancel-propagation')
    const messages = buildConversation(10)
    await saveSession(sid, messages, {
      cwd: '/tmp/project',
      model: 'test-model',
      lastInputTokens: 100_000,
      lastOutputTokens: 200,
    })
    const before = await loadSession(sid)

    const cleanup = { ran: false }
    const stream = compactSessionStream({
      sessionId: sid,
      provider: makeCancellableProvider(cleanup),
    })

    // Consume through at least one real provider progress delta
    let sawProgress = false
    while (!sawProgress) {
      const next = await stream.next()
      if (next.done) throw new Error('stream completed before a progress event')
      if ((next.value as { phase?: string }).phase === 'progress') sawProgress = true
    }

    // Cancel the PUBLIC stream — with direct yield* delegation the .return()
    // propagates: compactSessionStream → compactConversationWithProtectedTail →
    // compactConversationStream → provider's createMessageStream (finally).
    await stream.return?.(undefined as never)

    // Provider cleanup ran (cancellation reached the innermost generator)
    expect(cleanup.ran).toBe(true)

    // And the persisted session is still untouched
    const after = await loadSession(sid)
    expect(after!.messages).toEqual(before!.messages)
    expect(after!.metadata.lastInputTokens).toBe(100_000)
    expect(after!.metadata.summary).toBeUndefined()
  })

  it('resume after successful compaction does not auto-compact again (stale usage cleared)', async () => {
    const sid = freshSessionId('resume')
    await saveSession(sid, buildConversation(10), {
      cwd: '/tmp/project',
      model: 'test-model',
      lastInputTokens: 429_962, // well above any auto-compact threshold
      lastOutputTokens: 546,
    })

    // Sanity: pre-compaction state WOULD auto-compact
    const beforeState = {
      ...createAutoCompactState(),
      lastInputTokens: 429_962,
      lastOutputTokens: 546,
    }
    expect(shouldAutoCompact(beforeState, 'test-model')).toBe(true)

    await compactSession({ sessionId: sid, provider: makeNonStreamingProvider() })

    // Post-compaction persisted usage must no longer trigger auto-compact
    const persisted = await loadSession(sid)
    const resumeState = {
      ...createAutoCompactState(),
      lastInputTokens: persisted!.metadata.lastInputTokens ?? 0,
      lastOutputTokens: persisted!.metadata.lastOutputTokens ?? 0,
    }
    expect(shouldAutoCompact(resumeState, 'test-model')).toBe(false)
  })

  it('streams start/progress/end events compatible with existing compaction interfaces', async () => {
    const sid = freshSessionId('events')
    await saveSession(sid, buildConversation(10), {
      cwd: '/tmp/project',
      model: 'test-model',
    })

    const events: Array<{ type: string; phase?: string }> = []
    const stream = compactSessionStream({
      sessionId: sid,
      provider: makeStreamingProvider(),
    })
    while (true) {
      const next = await stream.next()
      if (next.done) break
      events.push(next.value as { type: string; phase?: string })
    }

    const phases = events.map((e) => e.phase)
    expect(phases[0]).toBe('start')
    expect(phases[phases.length - 1]).toBe('end')
    expect(phases.slice(1, -1).every((p) => p === 'progress')).toBe(true)
    // Streaming provider's deltas surface as progress text
    const progressText = events
      .filter((e) => e.phase === 'progress')
      .map((e) => (e as { text?: string }).text ?? '')
      .join('')
    expect(progressText).toContain('SUMMARY-part-1')
  })

  it('uses opts.model only for the request — persisted metadata.model unchanged', async () => {
    const sid = freshSessionId('request-model')
    await saveSession(sid, buildConversation(10), {
      cwd: '/tmp/project',
      model: 'session-active-model',
    })

    const result = await compactSession({
      sessionId: sid,
      provider: makeNonStreamingProvider(),
      model: 'cheap-compaction-model',
    })

    expect(result.compacted).toBe(true)

    const persisted = await loadSession(sid)
    expect(persisted!.metadata.model).toBe('session-active-model')
  })

  it('honors a custom protectedQueries and defaults to the Agent.compactStream default', async () => {
    const sid = freshSessionId('queries')
    await saveSession(sid, buildConversation(10), {
      cwd: '/tmp/project',
      model: 'test-model',
    })

    const result = await compactSession({
      sessionId: sid,
      provider: makeNonStreamingProvider(),
      protectedQueries: 2,
    })

    // Only the last 2 user queries of history + final message survive verbatim
    const allText = JSON.stringify(result.messages)
    expect(allText).toContain('user query 9 question about topic-9')
    expect(allText).toContain('user query 10 question about topic-10')
    expect(allText).toContain('final user message')
    expect(allText).not.toContain('user query 8 question about topic-8')
  })

  it('exposes the same default protected-query count as Agent.compactStream()', () => {
    // The default is wired through in compact-session.ts; assert the constant
    // contract so a change to either default must consciously update both.
    expect(PRUNE_PROTECTED_QUERIES).toBe(4)
  })

  it('compactSessionStream prunes the tail by default and honors toolProtectedQueries', async () => {
    // Build + persist a session of 6 big-tool queries + final assistant using the
    // same saveSession/makeNonStreamingProvider helpers the neighboring tests use.
    const sid = await seedBigToolSession(6) // local helper: saves 6 × bigToolRound + assistantMsg
    const result = await drainSession(compactSessionStream({ sessionId: sid, provider: makeNonStreamingProvider() }))
    expect(result.compacted).toBe(true)
    const tailResults = result.messages.slice(2)
      .filter((m: any) => m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result')
      .map((m: any) => m.content[0].content)
    expect(tailResults[0]).toBe('[Old tool result content cleared]')
    expect(tailResults[3]).not.toBe('[Old tool result content cleared]')

    // override disables
    const sid2 = await seedBigToolSession(6)
    const r2 = await drainSession(compactSessionStream({ sessionId: sid2, provider: makeNonStreamingProvider(), toolProtectedQueries: 4 }))
    const cleared2 = r2.messages.filter((m: any) =>
      m.role === 'user' && Array.isArray(m.content) &&
      m.content[0]?.type === 'tool_result' &&
      m.content[0].content === '[Old tool result content cleared]')
    expect(cleared2).toHaveLength(0)
  })
})

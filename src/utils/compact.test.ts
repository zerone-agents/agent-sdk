import { describe, expect, it } from 'vitest'
import {
  compactConversationWithProtectedTail,
  computeProtectedBoundary,
  createAutoCompactState,
  PRUNE_PROTECTED_QUERIES,
  pruneMessages,
  PRUNE_THRESHOLD_CHARS,
  TOOL_PROTECTED_QUERIES,
} from './compact.js'
import type { LLMProvider, CreateMessageResponse } from '../providers/types.js'
import type { NormalizedMessageParam } from '../providers/types.js'

function userMsg(text: string): NormalizedMessageParam {
  return { role: 'user', content: text }
}
function assistantMsg(text: string): NormalizedMessageParam {
  return { role: 'assistant', content: text }
}

/** Mock provider：非流式摘要，固定返回 summaryText */
function summaryProvider(summaryText = 'SUMMARY'): LLMProvider {
  return {
    apiType: 'anthropic-messages',
    async createMessage(): Promise<CreateMessageResponse> {
      return {
        content: [{ type: 'text', text: summaryText }],
        usage: { input_tokens: 1, output_tokens: 1 },
      } as CreateMessageResponse
    },
  }
}

async function drain(gen: ReturnType<typeof compactConversationWithProtectedTail>) {
  while (true) {
    const next = await gen.next()
    if (next.done) return next.value
  }
}

describe('compactConversationWithProtectedTail protectedQueries', () => {
  // 8 轮对话（最后一条是 assistant，作为被保护的 lastMsg）
  const eightQueries: NormalizedMessageParam[] = []
  for (let i = 1; i <= 8; i++) {
    eightQueries.push(userMsg(`query${i}`), assistantMsg(`resp${i}`))
  }

  it('defaults to PRUNE_PROTECTED_QUERIES tail when arg omitted', async () => {
    const result = await drain(compactConversationWithProtectedTail(
      summaryProvider(), 'm', eightQueries, createAutoCompactState(),
    ))
    expect(result.summary).toBe('SUMMARY')
    // [summary-user, summary-assistant, ...tail, lastMsg]
    const kept = JSON.stringify(result.messages.slice(2))
    expect(kept).toContain(`query${8 - PRUNE_PROTECTED_QUERIES + 1}`) // query5 when 4
    expect(kept).not.toContain('query1')
  })

  it('keeps more tail when protectedQueries is larger', async () => {
    const result = await drain(compactConversationWithProtectedTail(
      summaryProvider(), 'm', eightQueries, createAutoCompactState(), 5,
    ))
    const kept = JSON.stringify(result.messages.slice(2))
    expect(kept).toContain('query4') // protectedQueries=5 → query4..query8 保留
    expect(kept).not.toContain('query3')
  })
})

describe('buildCompactionPrompt content rules', () => {
  /** Mock provider：捕获收到的压缩 prompt */
  function captureProvider(): { provider: LLMProvider; getPrompt: () => string } {
    let prompt = ''
    return {
      getPrompt: () => prompt,
      provider: {
        apiType: 'anthropic-messages',
        async createMessage(params: any): Promise<CreateMessageResponse> {
          prompt = params.messages[0].content
          return {
            content: [{ type: 'text', text: 'S' }],
            usage: { input_tokens: 1, output_tokens: 1 },
          } as CreateMessageResponse
        },
      },
    }
  }

  function toolConversation(): NormalizedMessageParam[] {
    return [
      userMsg('x'.repeat(9000)),                                        // 超长 user 文本
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'y'.repeat(9000) },                     // 超长 assistant 文本
          { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/a/b.ts', offset: 10 } },
        ],
      } as any,
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'z'.repeat(9000) }],
      } as any,
      assistantMsg('last'),
    ]
  }

  it('truncates all text kinds to 5000 chars keeping head and tail', async () => {
    const { provider, getPrompt } = captureProvider()
    await drain(compactConversationWithProtectedTail(provider, 'm', toolConversation(), createAutoCompactState(), 0))
    const p = getPrompt()

    // 三类内容（user 纯文本、assistant 文本块、tool_result）各截一次
    const markerCount = p.split('...(truncated)...').length - 1
    expect(markerCount).toBe(3)

    // 9000 字符的原始完整内容不再出现
    expect(p).not.toContain('x'.repeat(9000))
    expect(p).not.toContain('y'.repeat(9000))
    expect(p).not.toContain('z'.repeat(9000))

    // 首尾各保留 2500：头部 2500 应存在（尾部与头部字符相同，无法区分，验证头部长度即可）
    expect(p).toContain('x'.repeat(2500))
    expect(p).toContain('y'.repeat(2500))
    expect(p).toContain('z'.repeat(2500))
  })

  it('keeps tool_use key arguments instead of dropping them', async () => {
    const { provider, getPrompt } = captureProvider()
    await drain(compactConversationWithProtectedTail(provider, 'm', toolConversation(), createAutoCompactState(), 0))
    expect(getPrompt()).toContain('[Tool: Read')
    expect(getPrompt()).toContain('/a/b.ts')
  })
})

describe('compaction timestamps (issue #54)', () => {
  function stampedQueries(n: number): NormalizedMessageParam[] {
    const out: NormalizedMessageParam[] = []
    for (let i = 1; i <= n; i++) {
      out.push(
        { role: 'user', content: `query${i}`, id: `u${i}`, timestamp: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() },
        { role: 'assistant', content: `resp${i}`, id: `a${i}`, timestamp: new Date(Date.UTC(2026, 0, 1, 0, i, 30)).toISOString() },
      )
    }
    return out
  }

  it('summary pair shares one timestamp and both messages have ids', async () => {
    const result = await drain(compactConversationWithProtectedTail(
      summaryProvider(), 'm', stampedQueries(8), createAutoCompactState(),
    ))
    const [summaryUser, summaryAssistant] = result.messages
    expect(summaryUser.id).toBeTruthy()
    expect(summaryAssistant.id).toBeTruthy()
    expect(summaryUser.timestamp).toBe(summaryAssistant.timestamp)
    expect(Date.parse(summaryUser.timestamp!)).not.toBeNaN()
  })

  it('protected tail timestamps are preserved verbatim', async () => {
    const queries = stampedQueries(8)
    const result = await drain(compactConversationWithProtectedTail(
      summaryProvider(), 'm', queries, createAutoCompactState(),
    ))
    const kept = result.messages.slice(2)
    // [.. pair, ...tailMsgs, lastMsg] is a contiguous suffix of `queries`
    const originalKept = queries.slice(queries.length - kept.length)
    expect(kept.map((m) => m.timestamp)).toEqual(originalKept.map((m) => m.timestamp))
  })

  it('failed compaction leaves the original timestamps untouched', async () => {
    const failing: LLMProvider = {
      apiType: 'anthropic-messages',
      async createMessage(): Promise<CreateMessageResponse> {
        throw new Error('summary provider down')
      },
    }
    const queries = stampedQueries(8)
    const before = queries.map((m) => m.timestamp)
    const result = await drain(compactConversationWithProtectedTail(
      failing, 'm', queries, createAutoCompactState(),
    ))
    expect(result.summary).toBe('')
    expect(result.messages.map((m) => m.timestamp)).toEqual(before)
  })
})

/** One query = [user prompt, assistant tool_use, user tool_result wrapper]. */
function toolRound(prompt: string, id: string, resultText: string): NormalizedMessageParam[] {
  return [
    userMsg(prompt),
    { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: {} }] } as unknown as NormalizedMessageParam,
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: resultText }] } as unknown as NormalizedMessageParam,
  ]
}

describe('computeProtectedBoundary (query-range primitive)', () => {
  it('returns the index of the Nth-from-last real query start', () => {
    const msgs: NormalizedMessageParam[] = []
    for (let i = 1; i <= 6; i++) msgs.push(...toolRound(`q${i}`, `id${i}`, 'ok'))
    // query-start indices: 0,3,6,9,12,15; last 4 → boundary at index 6
    expect(computeProtectedBoundary(msgs, 4)).toBe(6)
  })

  it('tool_result wrapper messages do not consume a slot', () => {
    const msgs = [...toolRound('q1', 'a', 'ok'), ...toolRound('q2', 'b', 'ok')]
    expect(computeProtectedBoundary(msgs, 1)).toBe(3) // q2's index, not its wrapper
  })

  it('a pending user query (no results yet) legitimately occupies a slot', () => {
    const msgs = [...toolRound('q1', 'a', 'ok'), ...toolRound('q2', 'b', 'ok'), userMsg('q3 pending')]
    // last 1 = q3 pending (index 6); last 2 = q2 (index 3)
    expect(computeProtectedBoundary(msgs, 1)).toBe(6)
    expect(computeProtectedBoundary(msgs, 2)).toBe(3)
  })

  it('queries >= count protects everything (boundary 0); <= 0 protects nothing (boundary length)', () => {
    const msgs = [...toolRound('q1', 'a', 'ok')]
    expect(computeProtectedBoundary(msgs, 4)).toBe(0)
    expect(computeProtectedBoundary(msgs, 0)).toBe(msgs.length)
  })

  it('no real query → boundary 0', () => {
    const msgs: NormalizedMessageParam[] = [assistantMsg('x')]
    expect(computeProtectedBoundary(msgs, 4)).toBe(0)
  })

  it('PRECEDENCE: queries <= 0 wins even when the window has no real query', () => {
    // A window that is ONLY a tool_result wrapper (no real query start).
    const wrapper: NormalizedMessageParam[] = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'x' }] } as unknown as NormalizedMessageParam,
    ]
    expect(computeProtectedBoundary(wrapper, 0)).toBe(1) // 0 = no protection → clearable
    expect(computeProtectedBoundary(wrapper, 4)).toBe(0) // positive + no query → all protected
  })

  it('MIXED-CONTENT: a [text, tool_result] user message IS a query start', () => {
    const msgs: NormalizedMessageParam[] = [
      ...toolRound('q1', 'a', 'ok'),
      { role: 'user', content: [
        { type: 'text', text: '继续处理这个结果' },
        { type: 'tool_result', tool_use_id: 'b', content: 'r' },
      ] } as unknown as NormalizedMessageParam,
      assistantMsg('resp'),
    ]
    // Query starts = q1 (index 0) and the MIXED message (index 3) — identical
    // semantics to session-queries.test.ts:142. Last 1 → boundary at 3.
    // (The deleted compact.ts variant `!some(tool_result)` would have said
    // boundary 0 — this test pins the unified predicate.)
    expect(computeProtectedBoundary(msgs, 1)).toBe(3)
  })
})

it('TOOL_PROTECTED_QUERIES defaults to 2', () => {
  expect(TOOL_PROTECTED_QUERIES).toBe(2)
})

const BIG = 'x'.repeat(PRUNE_THRESHOLD_CHARS + 1)

function bigToolRound(prompt: string, id: string, name = 'Read'): NormalizedMessageParam[] {
  return [
    userMsg(prompt),
    { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] } as unknown as NormalizedMessageParam,
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: BIG }] } as unknown as NormalizedMessageParam,
  ]
}

describe('pruneMessages — P0 range protection (behavior change #1)', () => {
  it('protects the last N queries RANGE and clears older big results', () => {
    const msgs: NormalizedMessageParam[] = []
    for (let i = 1; i <= 6; i++) msgs.push(...bigToolRound(`q${i}`, `id${i}`))
    pruneMessages(msgs, 4)
    // boundary at q3 (index 6): q1/q2 rounds cleared, q3..q6 retained
    expect((msgs[2] as any).content[0].content).toBe('[Old tool result content cleared]') // q1 result
    expect((msgs[5] as any).content[0].content).toBe('[Old tool result content cleared]') // q2 result
    expect((msgs[8] as any).content[0].content).toBe(BIG) // q3 result
    expect((msgs[17] as any).content[0].content).toBe(BIG) // q6 result
  })

  it('mutates in place and returns void (public contract unchanged)', () => {
    const msgs = bigToolRound('q1', 'a')
    const ret = pruneMessages(msgs, 0)
    expect(ret).toBeUndefined()
    expect((msgs[2] as any).content[0].content).toBe('[Old tool result content cleared]') // input itself mutated
  })

  it('default protectedQueries = PRUNE_PROTECTED_QUERIES (4)', () => {
    const msgs: NormalizedMessageParam[] = []
    for (let i = 1; i <= 6; i++) msgs.push(...bigToolRound(`q${i}`, `id${i}`))
    pruneMessages(msgs) // no second arg
    expect((msgs[2] as any).content[0].content).toBe('[Old tool result content cleared]')
    expect((msgs[8] as any).content[0].content).toBe(BIG)
  })

  it('leaves results under the threshold untouched', () => {
    const msgs: NormalizedMessageParam[] = [
      userMsg('q1'),
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Read', input: {} }] } as unknown as NormalizedMessageParam,
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'small' }] } as unknown as NormalizedMessageParam,
    ]
    pruneMessages(msgs, 0)
    expect((msgs[2] as any).content[0].content).toBe('small')
  })

  it('never clears a Skill tool_result even outside the window', () => {
    const msgs = bigToolRound('q1', 'a', 'Skill')
    pruneMessages(msgs, 0)
    expect((msgs[2] as any).content[0].content).toBe(BIG)
  })

  it('preserves tool_use blocks and tool_use↔tool_result pairing', () => {
    const msgs = bigToolRound('q1', 'a')
    pruneMessages(msgs, 0)
    expect((msgs[1] as any).content[0].type).toBe('tool_use')
    expect((msgs[2] as any).content[0].type).toBe('tool_result')
    expect((msgs[2] as any).content[0].tool_use_id).toBe('a')
  })

  it('MIXED-CONTENT query start: its own tool_result is protected in-window', () => {
    const msgs: NormalizedMessageParam[] = [
      ...bigToolRound('q1', 'a'),
      { role: 'user', content: [
        { type: 'text', text: '继续处理这个结果' },
        { type: 'tool_result', tool_use_id: 'b', content: BIG },
      ] } as unknown as NormalizedMessageParam,
    ]
    // Query starts = q1 (0) and the mixed message (3); protect last 1 → boundary 3
    pruneMessages(msgs, 1)
    expect((msgs[2] as any).content[0].content).toBe('[Old tool result content cleared]') // q1's result: older query → cleared
    expect((msgs[3] as any).content[1].content).toBe(BIG) // mixed message's own result: in-window → KEPT
  })
})

import { describe, expect, it } from 'vitest'
import {
  compactConversationWithProtectedTail,
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

  // Split boundary contract via the shared primitive (spec v4.4 §4): a history
  // with NO real user query is ALL protected → nothing to summarize → the
  // provider must NOT be called; identity return (same contract shape as the
  // <2 / failure paths). The old hand-rolled index math sent EVERYTHING to the
  // summarization head for this shape — the opposite of the contract.

  function noQueryHistory(): NormalizedMessageParam[] {
    return [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r1' }] } as unknown as NormalizedMessageParam,
      assistantMsg('a1'),
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'r2' }] } as unknown as NormalizedMessageParam,
      assistantMsg('a2'),
    ]
  }

  function countingProvider(): { provider: LLMProvider; calls: () => number } {
    let calls = 0
    const provider: LLMProvider = {
      apiType: 'anthropic-messages',
      async createMessage(): Promise<CreateMessageResponse> {
        calls++
        return {
          content: [{ type: 'text', text: 'SUM' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        } as CreateMessageResponse
      },
    }
    return { provider, calls: () => calls }
  }

  it('no-query history + default protectedQueries → provider NOT called, identity return', async () => {
    const msgs = noQueryHistory()
    const { provider, calls } = countingProvider()
    const result = await drain(
      compactConversationWithProtectedTail(provider, 'm', msgs, createAutoCompactState()),
    )
    expect(calls()).toBe(0)
    expect(result.summary).toBe('')
    expect(result.messages).toBe(msgs) // SAME array identity — never re-assembled
  })

  it('no-query history + protectedQueries=0 → provider called once, head summarized', async () => {
    const msgs = noQueryHistory()
    const { provider, calls } = countingProvider()
    const result = await drain(
      compactConversationWithProtectedTail(provider, 'm', msgs, createAutoCompactState(), 0),
    )
    expect(calls()).toBe(1)
    expect(result.summary).toBe('SUM')
    // [summary pair + lastMsg] — the whole history minus lastMsg became head.
    const first = result.messages[0] as any
    expect(typeof first.content).toBe('string')
    expect(first.content).toContain('[Previous conversation summary]')
    expect(first.content).toContain('SUM')
    expect((result.messages[1] as any).role).toBe('assistant')
    expect(result.messages).toHaveLength(3) // pair + empty tail + lastMsg
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

it('TOOL_PROTECTED_QUERIES defaults to 2', () => {
  expect(TOOL_PROTECTED_QUERIES).toBe(2)
})

it('protected-query defaults (contract)', () => {
  expect(PRUNE_PROTECTED_QUERIES).toBe(4)
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

  // Protected-window semantics of the SHARED boundary primitive, observed
  // through this public surface (the primitive itself is module-internal).

  it('window with NO real query + protectedQueries=4 → nothing cleared (all protected)', () => {
    const msgs: NormalizedMessageParam[] = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: BIG }] } as unknown as NormalizedMessageParam,
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] } as unknown as NormalizedMessageParam,
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: BIG }] } as unknown as NormalizedMessageParam,
    ]
    pruneMessages(msgs, 4)
    expect((msgs[0] as any).content[0].content).toBe(BIG)
    expect((msgs[2] as any).content[0].content).toBe(BIG)
  })

  it('same no-query window + protectedQueries=0 → everything cleared (precedence observable)', () => {
    const msgs: NormalizedMessageParam[] = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: BIG }] } as unknown as NormalizedMessageParam,
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] } as unknown as NormalizedMessageParam,
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: BIG }] } as unknown as NormalizedMessageParam,
    ]
    pruneMessages(msgs, 0)
    expect((msgs[0] as any).content[0].content).toBe('[Old tool result content cleared]')
    expect((msgs[2] as any).content[0].content).toBe('[Old tool result content cleared]')
  })

  it('pending user query occupies the slot: queries=1 clears q3 big result', () => {
    const msgs: NormalizedMessageParam[] = [
      ...bigToolRound('q1', 'id1'),
      ...bigToolRound('q2', 'id2'),
      ...bigToolRound('q3', 'id3'),
      userMsg('pending question'),
    ]
    // starts = [0, 3, 6, 9(pending)] → queries=1 → boundary=9 → q3's result
    // (index 8) sits OUTSIDE the window → cleared. Without the pending msg
    // the boundary would be 6 and index 8 would keep BIG.
    pruneMessages(msgs, 1)
    expect((msgs[2] as any).content[0].content).toBe('[Old tool result content cleared]')
    expect((msgs[5] as any).content[0].content).toBe('[Old tool result content cleared]')
    expect((msgs[8] as any).content[0].content).toBe('[Old tool result content cleared]')
  })
})

describe('compact-time tool pruning (spec v4 §4)', () => {
  function bigQueries(n: number): NormalizedMessageParam[] {
    const msgs: NormalizedMessageParam[] = []
    for (let i = 1; i <= n; i++) msgs.push(...bigToolRound(`q${i}`, `id${i}`))
    msgs.push(assistantMsg('final')) // lastMsg = assistant
    return msgs
  }

  it('clears big results beyond the most recent toolProtectedQueries of the tail', async () => {
    const result = await drain(compactConversationWithProtectedTail(
      summaryProvider(), 'm', bigQueries(6), createAutoCompactState(),
    ))
    // text tail = last 4 queries (q3..q6); tool window protects last 2 (q5,q6)
    const results = result.messages.slice(2)
      .filter((m: any) => m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result')
      .map((m: any) => m.content[0].content)
    expect(results).toHaveLength(4)          // q3..q6
    expect(results[0]).toBe('[Old tool result content cleared]') // q3
    expect(results[1]).toBe('[Old tool result content cleared]') // q4
    expect(results[2]).toBe(BIG)                                    // q5
    expect(results[3]).toBe(BIG)                                    // q6
  })

  it('toolProtectedQueries >= window disables clearing', async () => {
    const result = await drain(compactConversationWithProtectedTail(
      summaryProvider(), 'm', bigQueries(6), createAutoCompactState(), 4, 4,
    ))
    const cleared = result.messages.filter((m: any) =>
      m.role === 'user' && Array.isArray(m.content) &&
      m.content[0]?.type === 'tool_result' &&
      m.content[0].content === '[Old tool result content cleared]')
    expect(cleared).toHaveLength(0)
  })

  it('lastMsg variance is PINNED: pending user lastMsg leaves N-1 completed queries full', async () => {
    const msgs: NormalizedMessageParam[] = []
    for (let i = 1; i <= 5; i++) msgs.push(...bigToolRound(`q${i}`, `id${i}`))
    msgs.push(userMsg('pending final query')) // lastMsg = pending user → occupies a slot
    const result = await drain(compactConversationWithProtectedTail(
      summaryProvider(), 'm', msgs, createAutoCompactState(), 4, 2,
    ))
    // window [q2..q5, pending] (tail keeps 4 completed queries; pending occupies
    // a slot): last 2 slots = q5 + pending → q2/q3/q4 cleared, q5 full
    const results = result.messages.slice(2)
      .filter((m: any) => m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result')
      .map((m: any) => m.content[0].content)
    expect(results).toHaveLength(4)                                 // q2..q5
    expect(results[0]).toBe('[Old tool result content cleared]') // q2
    expect(results[1]).toBe('[Old tool result content cleared]') // q3
    expect(results[2]).toBe('[Old tool result content cleared]') // q4
    expect(results[3]).toBe(BIG)                                    // q5 — only 1 completed query full
  })

  it('MIXED-CONTENT lastMsg counts as a query and keeps its own result', async () => {
    const msgs: NormalizedMessageParam[] = []
    for (let i = 1; i <= 5; i++) msgs.push(...bigToolRound(`q${i}`, `id${i}`))
    msgs.push({ role: 'user', content: [
      { type: 'text', text: '继续处理这个结果' },
      { type: 'tool_result', tool_use_id: 'idM', content: BIG },
    ] } as unknown as NormalizedMessageParam) // lastMsg = mixed
    const result = await drain(compactConversationWithProtectedTail(
      summaryProvider(), 'm', msgs, createAutoCompactState(), 4, 2,
    ))
    // 5 starts > protectedQueries=4 → NON-degenerate head (q1 summarized).
    // Window queries (last 2 of [q2..q5, mixed]) = q5 + mixed → q2..q4
    // cleared — q4 clears ONLY because the MIXED lastMsg counts as a query
    // and takes a slot. (Before the split-boundary unification this test used
    // 4 rounds: with protectedQueries=4 the whole history is protected —
    // identity return — and the old shape only "passed" by feeding an EMPTY
    // head to the provider, the latent bug this round fixed.)
    const results = result.messages.slice(2)
      .filter((m: any) => m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result')
      .map((m: any) => m.content[0].content)
    expect(results).toEqual([
      '[Old tool result content cleared]',
      '[Old tool result content cleared]',
      '[Old tool result content cleared]',
      BIG, // q5 protected
    ])
    const mixed = result.messages.at(-1) as any
    expect(mixed.content[1].content).toBe(BIG) // mixed lastMsg's own result kept verbatim
  })

  it('failed compaction returns the ORIGINAL array identity, never pruned', async () => {
    const failing: LLMProvider = {
      apiType: 'anthropic-messages',
      async createMessage() { throw new Error('provider down') },
    }
    const msgs = bigQueries(6)
    const before = JSON.stringify(msgs)
    const result = await drain(compactConversationWithProtectedTail(
      failing, 'm', msgs, createAutoCompactState(),
    ))
    expect(result.summary).toBe('')
    expect(result.messages).toBe(msgs as any)      // identity — original array
    expect(JSON.stringify(msgs)).toBe(before)      // every object unchanged
  })

  it('success leaves the CALLER objects untouched (clone-delegate)', async () => {
    const msgs = bigQueries(6)
    const before = JSON.stringify(msgs)
    await drain(compactConversationWithProtectedTail(
      summaryProvider(), 'm', msgs, createAutoCompactState(),
    ))
    expect(JSON.stringify(msgs)).toBe(before)      // originals never mutated
  })

  it('messages.length < 2: copy returned, summary empty, no pruning', async () => {
    const result = await drain(compactConversationWithProtectedTail(
      summaryProvider(), 'm', [userMsg('only')], createAutoCompactState(),
    ))
    expect(result.summary).toBe('')
  })
})

describe('fractional protectedQueries guard (#92)', () => {
  // #92 review: typed extraction via the discriminated union — no `any`.
  function firstToolResultContent(msgs: NormalizedMessageParam[], index: number): unknown {
    const content = msgs[index].content
    if (!Array.isArray(content)) return undefined
    const first = content[0]
    return first?.type === 'tool_result' ? first.content : undefined
  }

  it('non-integer protectedQueries treated as no-protection (fail-open, no data loss)', () => {
    const msgs: NormalizedMessageParam[] = [
      ...bigToolRound('q1', 'id1'),
      ...bigToolRound('q2', 'id2'),
    ]
    pruneMessages(msgs, 2.5)
    // boundary = messages.length (nothing protected) → both oversized results cleared
    expect(firstToolResultContent(msgs, 2)).toBe('[Old tool result content cleared]')
    expect(firstToolResultContent(msgs, 5)).toBe('[Old tool result content cleared]')
  })

  it('integral protectedQueries (2.0) behaves as the integer 2', () => {
    const msgs: NormalizedMessageParam[] = [
      ...bigToolRound('q1', 'id1'),
      ...bigToolRound('q2', 'id2'),
    ]
    pruneMessages(msgs, 2.0)
    expect(firstToolResultContent(msgs, 2)).toBe(BIG)   // last-2 queries protected
    expect(firstToolResultContent(msgs, 5)).toBe(BIG)
  })
})

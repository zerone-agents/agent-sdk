import { describe, expect, it } from 'vitest'
import {
  compactConversationWithProtectedTail,
  createAutoCompactState,
  PRUNE_PROTECTED_QUERIES,
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
  const eightTurns: NormalizedMessageParam[] = []
  for (let i = 1; i <= 8; i++) {
    eightTurns.push(userMsg(`turn${i}`), assistantMsg(`resp${i}`))
  }

  it('defaults to PRUNE_PROTECTED_QUERIES tail when arg omitted', async () => {
    const result = await drain(compactConversationWithProtectedTail(
      summaryProvider(), 'm', eightTurns, createAutoCompactState(),
    ))
    expect(result.summary).toBe('SUMMARY')
    // [summary-user, summary-assistant, ...tail, lastMsg]
    const kept = JSON.stringify(result.messages.slice(2))
    expect(kept).toContain(`turn${8 - PRUNE_PROTECTED_QUERIES + 1}`) // turn5 when 4
    expect(kept).not.toContain('turn1')
  })

  it('keeps more tail when protectedQueries is larger', async () => {
    const result = await drain(compactConversationWithProtectedTail(
      summaryProvider(), 'm', eightTurns, createAutoCompactState(), 5,
    ))
    const kept = JSON.stringify(result.messages.slice(2))
    expect(kept).toContain('turn4') // protectedQueries=5 → turn4..turn8 保留
    expect(kept).not.toContain('turn3')
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
  function stampedTurns(n: number): NormalizedMessageParam[] {
    const out: NormalizedMessageParam[] = []
    for (let i = 1; i <= n; i++) {
      out.push(
        { role: 'user', content: `turn${i}`, id: `u${i}`, timestamp: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() },
        { role: 'assistant', content: `resp${i}`, id: `a${i}`, timestamp: new Date(Date.UTC(2026, 0, 1, 0, i, 30)).toISOString() },
      )
    }
    return out
  }

  it('summary pair shares one timestamp and both messages have ids', async () => {
    const result = await drain(compactConversationWithProtectedTail(
      summaryProvider(), 'm', stampedTurns(8), createAutoCompactState(),
    ))
    const [summaryUser, summaryAssistant] = result.messages
    expect(summaryUser.id).toBeTruthy()
    expect(summaryAssistant.id).toBeTruthy()
    expect(summaryUser.timestamp).toBe(summaryAssistant.timestamp)
    expect(Date.parse(summaryUser.timestamp!)).not.toBeNaN()
  })

  it('protected tail timestamps are preserved verbatim', async () => {
    const turns = stampedTurns(8)
    const result = await drain(compactConversationWithProtectedTail(
      summaryProvider(), 'm', turns, createAutoCompactState(),
    ))
    const kept = result.messages.slice(2)
    // [.. pair, ...tailMsgs, lastMsg] is a contiguous suffix of `turns`
    const originalKept = turns.slice(turns.length - kept.length)
    expect(kept.map((m) => m.timestamp)).toEqual(originalKept.map((m) => m.timestamp))
  })

  it('failed compaction leaves the original timestamps untouched', async () => {
    const failing: LLMProvider = {
      apiType: 'anthropic-messages',
      async createMessage(): Promise<CreateMessageResponse> {
        throw new Error('summary provider down')
      },
    }
    const turns = stampedTurns(8)
    const before = turns.map((m) => m.timestamp)
    const result = await drain(compactConversationWithProtectedTail(
      failing, 'm', turns, createAutoCompactState(),
    ))
    expect(result.summary).toBe('')
    expect(result.messages.map((m) => m.timestamp)).toEqual(before)
  })
})

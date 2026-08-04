import { describe, expect, it } from 'vitest'
import {
  compactConversationWithProtectedTail,
  createAutoCompactState,
  PRUNE_PROTECTED_TURNS,
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

describe('compactConversationWithProtectedTail protectedTurns', () => {
  // 8 轮对话（最后一条是 assistant，作为被保护的 lastMsg）
  const eightTurns: NormalizedMessageParam[] = []
  for (let i = 1; i <= 8; i++) {
    eightTurns.push(userMsg(`turn${i}`), assistantMsg(`resp${i}`))
  }

  it('defaults to PRUNE_PROTECTED_TURNS tail when arg omitted', async () => {
    const result = await drain(compactConversationWithProtectedTail(
      summaryProvider(), 'm', eightTurns, createAutoCompactState(),
    ))
    expect(result.summary).toBe('SUMMARY')
    // [summary-user, summary-assistant, ...tail, lastMsg]
    const kept = JSON.stringify(result.messages.slice(2))
    expect(kept).toContain(`turn${8 - PRUNE_PROTECTED_TURNS + 1}`) // turn3 when 6
    expect(kept).not.toContain('turn1')
  })

  it('keeps more tail when protectedTurns is larger', async () => {
    const result = await drain(compactConversationWithProtectedTail(
      summaryProvider(), 'm', eightTurns, createAutoCompactState(), 5,
    ))
    const kept = JSON.stringify(result.messages.slice(2))
    expect(kept).toContain('turn4') // protectedTurns=5 → turn4..turn8 保留
    expect(kept).not.toContain('turn3')
  })
})

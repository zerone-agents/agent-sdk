import { describe, expect, it } from 'vitest'
import { countSessionQueries, truncateToLastNQueries } from './session-queries.js'
import type { NormalizedMessageParam } from '../providers/types.js'

function userMsg(text: string): NormalizedMessageParam {
  return { role: 'user', content: text }
}

function assistantMsg(text: string): NormalizedMessageParam {
  return { role: 'assistant', content: text }
}

function assistantToolUseMsg(id: string): NormalizedMessageParam {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: 'a.txt' } }],
  }
}

function toolResultMsg(id: string): NormalizedMessageParam {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content: 'result' }],
  }
}

describe('truncateToLastNQueries', () => {
  it('returns all messages when turns <= maxQueries', () => {
    const messages: NormalizedMessageParam[] = [
      userMsg('hello'),
      assistantMsg('hi'),
      userMsg('bye'),
      assistantMsg('goodbye'),
    ]
    const result = truncateToLastNQueries(messages, 5)
    expect(result).toEqual(messages)
  })

  it('returns all messages when turns == maxQueries', () => {
    const messages: NormalizedMessageParam[] = [
      userMsg('a'),
      assistantMsg('b'),
      userMsg('c'),
      assistantMsg('d'),
    ]
    const result = truncateToLastNQueries(messages, 2)
    expect(result).toEqual(messages)
  })

  it('truncates to last N turns', () => {
    const messages: NormalizedMessageParam[] = [
      userMsg('turn1'),
      assistantMsg('resp1'),
      userMsg('turn2'),
      assistantMsg('resp2'),
      userMsg('turn3'),
      assistantMsg('resp3'),
    ]
    const result = truncateToLastNQueries(messages, 2)
    expect(result).toEqual([
      userMsg('turn2'),
      assistantMsg('resp2'),
      userMsg('turn3'),
      assistantMsg('resp3'),
    ])
  })

  it('does not split tool-use loops across turn boundaries', () => {
    const messages: NormalizedMessageParam[] = [
      userMsg('turn1'),
      assistantMsg('resp1'),
      userMsg('turn2'),
      assistantToolUseMsg('tu_1'),
      toolResultMsg('tu_1'),
      assistantMsg('resp2'),
      userMsg('turn3'),
      assistantMsg('resp3'),
    ]
    // 3 turns, keep last 2 → turn2 (including tool loop) + turn3
    const result = truncateToLastNQueries(messages, 2)
    expect(result).toEqual([
      userMsg('turn2'),
      assistantToolUseMsg('tu_1'),
      toolResultMsg('tu_1'),
      assistantMsg('resp2'),
      userMsg('turn3'),
      assistantMsg('resp3'),
    ])
  })

  it('returns all messages for empty array', () => {
    const result = truncateToLastNQueries([], 5)
    expect(result).toEqual([])
  })

  it('returns all messages when maxQueries is 1 and only 1 turn exists', () => {
    const messages: NormalizedMessageParam[] = [
      userMsg('only'),
      assistantMsg('one'),
    ]
    const result = truncateToLastNQueries(messages, 1)
    expect(result).toEqual(messages)
  })

  it('keeps only last turn when maxQueries is 1', () => {
    const messages: NormalizedMessageParam[] = [
      userMsg('first'),
      assistantMsg('resp1'),
      userMsg('second'),
      assistantMsg('resp2'),
    ]
    const result = truncateToLastNQueries(messages, 1)
    expect(result).toEqual([
      userMsg('second'),
      assistantMsg('resp2'),
    ])
  })

  it('handles multi-turn tool-use loops correctly', () => {
    const messages: NormalizedMessageParam[] = [
      userMsg('start'),
      assistantMsg('resp'),
      userMsg('task'),
      assistantToolUseMsg('tu_1'),
      toolResultMsg('tu_1'),
      assistantToolUseMsg('tu_2'),
      toolResultMsg('tu_2'),
      assistantMsg('done'),
    ]
    // 2 turns, keep last 1 → only the "task" turn with full tool loop
    const result = truncateToLastNQueries(messages, 1)
    expect(result).toEqual([
      userMsg('task'),
      assistantToolUseMsg('tu_1'),
      toolResultMsg('tu_1'),
      assistantToolUseMsg('tu_2'),
      toolResultMsg('tu_2'),
      assistantMsg('done'),
    ])
  })

  it('treats mixed content user message (text + tool_result) as fresh turn', () => {
    const messages: NormalizedMessageParam[] = [
      userMsg('first'),
      assistantMsg('resp1'),
      {
        role: 'user',
        content: [
          { type: 'text', text: 'also asking' },
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'result' },
        ],
      },
      assistantMsg('resp2'),
    ]
    // User message with both text and tool_result → has text → fresh turn
    const result = truncateToLastNQueries(messages, 1)
    expect(result).toHaveLength(2)
    expect(result[0].role).toBe('user')
    expect(result[1].role).toBe('assistant')
  })

  it('returns all messages when maxQueries is 0', () => {
    const messages: NormalizedMessageParam[] = [
      userMsg('a'),
      assistantMsg('b'),
    ]
    const result = truncateToLastNQueries(messages, 0)
    expect(result).toEqual(messages)
  })

  it('returns all messages when maxQueries is negative', () => {
    const messages: NormalizedMessageParam[] = [
      userMsg('a'),
      assistantMsg('b'),
    ]
    const result = truncateToLastNQueries(messages, -3)
    expect(result).toEqual(messages)
  })
})

describe('countSessionQueries', () => {
  it('counts fresh user messages only', () => {
    const messages: NormalizedMessageParam[] = [
      userMsg('turn1'),
      assistantMsg('resp1'),
      toolResultMsg('t1'),
      userMsg('turn2'),
      assistantMsg('resp2'),
    ]
    expect(countSessionQueries(messages)).toBe(2)
  })

  it('returns 0 for empty and tool-result-only histories', () => {
    expect(countSessionQueries([])).toBe(0)
    expect(countSessionQueries([toolResultMsg('t1')])).toBe(0)
  })
})

import { describe, it, expect } from 'vitest'
import {
  StreamAccumulator,
  parseStreamChunk,
  buildResponseFromChunks,
} from './stream-parser.js'
import type { StreamChunk } from '../providers/types.js'

function textChunk(index: number, delta: string): StreamChunk {
  return { type: 'text', index, delta }
}

function thinkingChunk(index: number, delta: string): StreamChunk {
  return { type: 'thinking', index, delta }
}

function toolUseChunk(
  index: number,
  id: string,
  name: string,
  input: string,
): StreamChunk {
  return { type: 'tool_use', index, id, name, input }
}

function usageChunk(
  index: number,
  usage: { input_tokens: number; output_tokens: number; totalInputTokens: number },
): StreamChunk {
  return { type: 'usage', index, usage }
}

function doneChunk(index: number): StreamChunk {
  return { type: 'done', index }
}

describe('StreamAccumulator', () => {
  describe('text accumulation', () => {
    it('accumulates consecutive text chunks into a single text part', () => {
      const acc = new StreamAccumulator()
      acc.addChunk(textChunk(0, 'Hello'))
      acc.addChunk(textChunk(0, ' world'))
      acc.addChunk(textChunk(0, '!'))

      const parts = acc.getParts()
      expect(parts).toHaveLength(1)
      expect(parts[0]).toEqual({ type: 'text', text: 'Hello world!' })
    })

    it('appends text after tool_use to current text block (tool_use does not reset currentBlock)', () => {
      const acc = new StreamAccumulator()
      acc.addChunk(textChunk(0, 'Before'))
      acc.addChunk(toolUseChunk(1, 't1', 'read_file', '{"path":"/tmp/x"}'))
      acc.addChunk(textChunk(2, 'After'))

      // tool_use goes to toolUses map, not to content. currentBlock stays text.
      // So "After" appends to "Before" → one text part "BeforeAfter"
      // buildResponse appends tool_use after text
      const response = acc.buildResponse()
      expect(response.content).toHaveLength(2) // text + tool_use
      expect(response.content[0]).toEqual({ type: 'text', text: 'BeforeAfter' })
      expect((response.content[1] as any).type).toBe('tool_use')
    })

    it('starts a new text part after a thinking block', () => {
      const acc = new StreamAccumulator()
      acc.addChunk(textChunk(0, 'Text'))
      acc.addChunk(thinkingChunk(1, 'Thinking'))
      acc.addChunk(textChunk(2, 'More text'))

      const parts = acc.getParts()
      expect(parts).toHaveLength(3)
      expect(parts[0]).toEqual({ type: 'text', text: 'Text' })
      expect(parts[1]).toEqual({ type: 'thinking', thinking: 'Thinking' })
      expect(parts[2]).toEqual({ type: 'text', text: 'More text' })
    })

    it('handles text with empty delta', () => {
      const acc = new StreamAccumulator()
      acc.addChunk(textChunk(0, 'Hi'))
      acc.addChunk({ type: 'text', index: 0, delta: '' })
      acc.addChunk(textChunk(0, '!'))

      const parts = acc.getParts()
      expect(parts).toHaveLength(1)
      // Original behavior: chunk.delta || '' → '' is falsy → appends ''
      expect((parts[0] as any).text).toBe('Hi!')
    })

    it('handles text with undefined delta', () => {
      const acc = new StreamAccumulator()
      acc.addChunk(textChunk(0, 'Hi'))
      acc.addChunk({ type: 'text', index: 0 })
      acc.addChunk(textChunk(0, '!'))

      const parts = acc.getParts()
      expect(parts).toHaveLength(1)
      expect((parts[0] as any).text).toBe('Hi!')
    })
  })

  describe('thinking accumulation', () => {
    it('accumulates consecutive thinking chunks', () => {
      const acc = new StreamAccumulator()
      acc.addChunk(thinkingChunk(0, 'Let me '))
      acc.addChunk(thinkingChunk(0, 'think...'))

      const parts = acc.getParts()
      expect(parts).toHaveLength(1)
      expect(parts[0]).toEqual({ type: 'thinking', thinking: 'Let me think...' })
    })

    it('starts a new thinking part after a text block', () => {
      const acc = new StreamAccumulator()
      acc.addChunk(thinkingChunk(0, 'First'))
      acc.addChunk(textChunk(1, 'Some text'))
      acc.addChunk(thinkingChunk(2, 'Second'))

      const parts = acc.getParts()
      expect(parts).toHaveLength(3)
      expect(parts[0]).toEqual({ type: 'thinking', thinking: 'First' })
      expect(parts[2]).toEqual({ type: 'thinking', thinking: 'Second' })
    })
  })

  describe('tool_use accumulation', () => {
    it('accumulates tool_use input chunks for the same index', () => {
      const acc = new StreamAccumulator()
      acc.addChunk(toolUseChunk(0, 't1', 'read_file', '{"path":'))
      acc.addChunk(toolUseChunk(0, 't1', '', '"/tmp/x"}'))

      // Tool use goes to toolUses map, not directly to content
      expect(acc.getParts()).toHaveLength(0)

      const response = acc.buildResponse()
      const tool = response.content[0] as any
      expect(tool.type).toBe('tool_use')
      expect(tool.id).toBe('t1')
      expect(tool.name).toBe('read_file')
      expect(tool.input).toEqual({ path: '/tmp/x' })
    })

    it('creates separate entries for different indices', () => {
      const acc = new StreamAccumulator()
      acc.addChunk(toolUseChunk(0, 't1', 'read_file', '{"path":"/a"}'))
      acc.addChunk(toolUseChunk(1, 't2', 'write_file', '{"path":"/b"}'))

      const response = acc.buildResponse()
      expect(response.content).toHaveLength(2)
      expect((response.content[0] as any).id).toBe('t1')
      expect((response.content[1] as any).id).toBe('t2')
    })

    it('skips tool_use with empty name', () => {
      const acc = new StreamAccumulator()
      acc.addChunk(toolUseChunk(0, 't1', '', '{"path":"/a"}'))

      const response = acc.buildResponse()
      expect(response.content).toHaveLength(0)
    })

    it('skips tool_use with empty input', () => {
      const acc = new StreamAccumulator()
      acc.addChunk(toolUseChunk(0, 't1', 'read_file', ''))

      const response = acc.buildResponse()
      expect(response.content).toHaveLength(0)
    })

    it('uses fallback id when id is empty', () => {
      const acc = new StreamAccumulator()
      acc.addChunk(toolUseChunk(5, '', 'read_file', '{"path":"/x"}'))

      const response = acc.buildResponse()
      expect(response.content).toHaveLength(1)
      expect((response.content[0] as any).id).toBe('tool_5')
    })
  })

  describe('ignoring non-content chunks', () => {
    it('ignores usage chunks (no content added)', () => {
      const acc = new StreamAccumulator()
      acc.addChunk(textChunk(0, 'Hello'))
      acc.addChunk(usageChunk(1, { input_tokens: 100, output_tokens: 50, totalInputTokens: 100 }))
      acc.addChunk(textChunk(2, '!'))

      const parts = acc.getParts()
      expect(parts).toHaveLength(1)
      expect((parts[0] as any).text).toBe('Hello!')
    })

    it('ignores done chunks', () => {
      const acc = new StreamAccumulator()
      acc.addChunk(textChunk(0, 'Hello'))
      acc.addChunk(doneChunk(1))

      const parts = acc.getParts()
      expect(parts).toHaveLength(1)
      expect((parts[0] as any).text).toBe('Hello')
    })
  })

  describe('reset', () => {
    it('clears all state', () => {
      const acc = new StreamAccumulator()
      acc.addChunk(textChunk(0, 'Hello'))
      acc.addChunk(toolUseChunk(1, 't1', 'read_file', '{"path":"/x"}'))

      acc.reset()
      expect(acc.getParts()).toHaveLength(0)

      // After reset, buildResponse should produce empty content
      const response = acc.buildResponse()
      expect(response.content).toHaveLength(0)
    })
  })

  describe('buildResponse', () => {
    it('parses tool_use input JSON', () => {
      const acc = new StreamAccumulator()
      acc.addChunk(toolUseChunk(0, 't1', 'read_file', '{"path":"/tmp/x"}'))

      const response = acc.buildResponse()
      const tool = response.content[0] as any
      expect(tool.input).toEqual({ path: '/tmp/x' })
    })

    it('falls back to raw input on malformed JSON', () => {
      const acc = new StreamAccumulator()
      acc.addChunk(toolUseChunk(0, 't1', 'read_file', 'not-json'))

      const response = acc.buildResponse()
      const tool = response.content[0] as any
      expect(tool.input).toBe('not-json')
    })

    it('returns zero usage (caller assigns usage separately)', () => {
      const acc = new StreamAccumulator()
      acc.addChunk(textChunk(0, 'Hello'))

      const response = acc.buildResponse()
      expect(response.usage.input_tokens).toBe(0)
      expect(response.usage.output_tokens).toBe(0)
    })

    it('sets stopReason to tool_use when tools present', () => {
      const acc = new StreamAccumulator()
      acc.addChunk(textChunk(0, 'Hello'))
      acc.addChunk(toolUseChunk(1, 't1', 'read_file', '{"path":"/x"}'))

      const response = acc.buildResponse()
      expect(response.stopReason).toBe('tool_use')
    })

    it('sets stopReason to end_turn when no tools', () => {
      const acc = new StreamAccumulator()
      acc.addChunk(textChunk(0, 'Hello'))

      const response = acc.buildResponse()
      expect(response.stopReason).toBe('end_turn')
    })

    it('handles empty accumulator', () => {
      const acc = new StreamAccumulator()
      const response = acc.buildResponse()
      expect(response.content).toHaveLength(0)
      expect(response.stopReason).toBe('end_turn')
    })
  })
})

describe('parseStreamChunk', () => {
  it('is a convenience wrapper around StreamAccumulator.addChunk', () => {
    const acc = new StreamAccumulator()
    parseStreamChunk(textChunk(0, 'Hello'), acc)
    parseStreamChunk(textChunk(0, ' world'), acc)

    const parts = acc.getParts()
    expect(parts).toHaveLength(1)
    expect((parts[0] as any).text).toBe('Hello world')
  })
})

describe('buildResponseFromChunks', () => {
  it('builds a complete response from a sequence of chunks', () => {
    const chunks: StreamChunk[] = [
      textChunk(0, 'Let me read that file.'),
      toolUseChunk(1, 't1', 'read_file', '{"path":"/tmp/x"}'),
      usageChunk(2, { input_tokens: 100, output_tokens: 50, totalInputTokens: 100 }),
      doneChunk(3),
    ]

    const response = buildResponseFromChunks(chunks)

    expect(response.content).toHaveLength(2)
    expect(response.content[0]).toEqual({ type: 'text', text: 'Let me read that file.' })
    const tool = response.content[1] as any
    expect(tool.type).toBe('tool_use')
    expect(tool.id).toBe('t1')
    expect(tool.name).toBe('read_file')
    expect(tool.input).toEqual({ path: '/tmp/x' })
    // Usage is zero — caller assigns it after buildResponseFromChunks
    expect(response.usage.input_tokens).toBe(0)
  })

  it('handles thinking + text + tool_use interleaving', () => {
    const chunks: StreamChunk[] = [
      thinkingChunk(0, 'I should use '),
      thinkingChunk(0, 'a tool here.'),
      textChunk(1, 'Running the tool now.'),
      toolUseChunk(2, 't1', 'bash', '{"command":"ls"}'),
    ]

    const response = buildResponseFromChunks(chunks)

    // thinking → one thinking block
    // text → currentBlock changes to text, new text block
    // tool_use → goes to toolUses map, currentBlock stays text
    // buildResponse → appends tool_use after text
    expect(response.content).toHaveLength(3)
    expect(response.content[0]).toEqual({ type: 'thinking', thinking: 'I should use a tool here.' })
    expect(response.content[1]).toEqual({ type: 'text', text: 'Running the tool now.' })
    expect((response.content[2] as any).type).toBe('tool_use')
    expect((response.content[2] as any).name).toBe('bash')
  })

  it('handles multiple parallel tool calls', () => {
    const chunks: StreamChunk[] = [
      toolUseChunk(0, 't1', 'read_file', '{"path":"/a"}'),
      toolUseChunk(1, 't2', 'read_file', '{"path":"/b"}'),
      toolUseChunk(2, 't3', 'write_file', '{"path":"/c","content":"hi"}'),
    ]

    const response = buildResponseFromChunks(chunks)
    expect(response.content).toHaveLength(3)
    expect((response.content[0] as any).id).toBe('t1')
    expect((response.content[1] as any).id).toBe('t2')
    expect((response.content[2] as any).id).toBe('t3')
    expect((response.content[2] as any).input).toEqual({ path: '/c', content: 'hi' })
  })

  it('handles empty chunk array', () => {
    const response = buildResponseFromChunks([])
    expect(response.content).toHaveLength(0)
  })

  it('handles text-only stream', () => {
    const chunks: StreamChunk[] = [
      textChunk(0, 'Hello '),
      textChunk(0, 'world!'),
    ]

    const response = buildResponseFromChunks(chunks)
    expect(response.content).toHaveLength(1)
    expect(response.content[0]).toEqual({ type: 'text', text: 'Hello world!' })
    expect(response.stopReason).toBe('end_turn')
  })

  it('handles tool_use with missing optional fields (skips empty name+input)', () => {
    const chunks: StreamChunk[] = [
      { type: 'tool_use', index: 0 } as StreamChunk,
    ]

    // Empty name + empty input → skipped
    const response = buildResponseFromChunks(chunks)
    expect(response.content).toHaveLength(0)
  })

  it('reproduces the exact logic of the old buildResponseFromChunks', () => {
    // This test mirrors the original engine.ts implementation behavior
    const chunks: StreamChunk[] = [
      { type: 'text', index: 0, delta: 'I will ' },
      { type: 'text', index: 0, delta: 'run ' },
      { type: 'text', index: 0, delta: 'the tool.' },
      { type: 'tool_use', index: 1, id: 'toolu_01', name: 'bash', input: '{"com' },
      { type: 'tool_use', index: 1, id: 'toolu_01', name: '', input: 'mand":"ls"}' },
      { type: 'usage', index: 2, usage: { input_tokens: 500, output_tokens: 100, totalInputTokens: 500 } },
      { type: 'done', index: 3 },
    ]

    const response = buildResponseFromChunks(chunks)

    expect(response.content).toHaveLength(2)
    expect(response.content[0]).toEqual({ type: 'text', text: 'I will run the tool.' })
    const tool = response.content[1] as any
    expect(tool.type).toBe('tool_use')
    expect(tool.id).toBe('toolu_01')
    expect(tool.name).toBe('bash')
    expect(tool.input).toEqual({ command: 'ls' })
    expect(response.stopReason).toBe('tool_use')
    // Usage is zeroed — caller assigns it
    expect(response.usage.input_tokens).toBe(0)
  })
})

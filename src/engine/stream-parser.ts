/**
 * Stream parser: converts raw provider StreamChunk arrays into a structured
 * CreateMessageResponse. Extracted from engine.ts so the accumulation logic
 * is independently testable without constructing a full QueryEngine.
 */

import type {
  CreateMessageResponse,
  NormalizedResponseBlock,
  StreamChunk,
} from '../providers/types.js'

/**
 * Accumulates stream chunks into a structured response.
 *
 * The provider streams incremental deltas (text, thinking, tool_use input).
 * This class merges them into complete blocks — consecutive text deltas become
 * a single text part, tool_use deltas are concatenated as JSON strings per
 * chunk index and parsed once at the end, and usage/warnings can be attached
 * separately after the stream completes.
 */
export class StreamAccumulator {
  private content: NormalizedResponseBlock[] = []
  private currentBlock: NormalizedResponseBlock | null = null
  private toolUses = new Map<number, { id: string; name: string; input: string }>()

  /**
   * Process a single stream chunk, merging its delta into the accumulated parts.
   */
  addChunk(chunk: StreamChunk): void {
    if (chunk.type === 'done') return

    if (chunk.type === 'text') {
      if (!this.currentBlock || this.currentBlock.type !== 'text') {
        this.currentBlock = { type: 'text', text: chunk.delta || '' }
        this.content.push(this.currentBlock)
      } else {
        this.currentBlock.text += chunk.delta || ''
      }
    }

    if (chunk.type === 'thinking') {
      if (!this.currentBlock || this.currentBlock.type !== 'thinking') {
        this.currentBlock = { type: 'thinking', thinking: chunk.delta || '' }
        this.content.push(this.currentBlock)
      } else {
        this.currentBlock.thinking += chunk.delta || ''
      }
    }

    if (chunk.type === 'tool_use') {
      const toolUse = this.toolUses.get(chunk.index) || { id: '', name: '', input: '' }
      if (chunk.id) {
        toolUse.id = chunk.id
      }
      if (chunk.name) {
        toolUse.name = chunk.name
      }
      if (chunk.input !== undefined && chunk.input !== '') {
        toolUse.input += chunk.input
      }
      this.toolUses.set(chunk.index, toolUse)
    }
  }

  /**
   * Build the final response from accumulated parts.
   *
   * Usage and warnings are intentionally NOT included here — the caller
   * assigns them from the stream's terminal chunk (matching the original
   * engine behavior where `response.usage = usage` is set after this call).
   */
  buildResponse(): CreateMessageResponse {
    // Process accumulated tool_use entries: parse input JSON and append to content.
    // Skip tool calls whose input was never received (e.g. stream aborted after
    // content_block_start but before input_json_delta).
    for (const [index, toolUse] of this.toolUses) {
      if (toolUse.name && toolUse.input) {
        let input: any
        try {
          input = JSON.parse(toolUse.input)
        } catch {
          input = toolUse.input
        }
        this.content.push({
          type: 'tool_use',
          id: toolUse.id || `tool_${index}`,
          name: toolUse.name,
          input,
        })
      }
    }

    // Determine stop reason based on content
    const hasToolUse = this.content.some(block => block.type === 'tool_use')

    return {
      content: this.content,
      stopReason: hasToolUse ? 'tool_use' : 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0, totalInputTokens: 0 },
    }
  }

  /** Get all accumulated content parts (for inspection/testing). */
  getParts(): readonly NormalizedResponseBlock[] {
    return this.content
  }

  /** Reset accumulator state. */
  reset(): void {
    this.content = []
    this.currentBlock = null
    this.toolUses.clear()
  }
}

/**
 * Process a single stream chunk into the given accumulator.
 * Pure convenience wrapper around StreamAccumulator.addChunk().
 */
export function parseStreamChunk(chunk: StreamChunk, accumulator: StreamAccumulator): void {
  accumulator.addChunk(chunk)
}

/**
 * Build a CreateMessageResponse from an array of stream chunks.
 *
 * This is the direct replacement for the old QueryEngine.buildResponseFromChunks()
 * method — used when a stream completes and we need to reassemble the full
 * response for history and tool execution.
 *
 * The caller assigns `response.usage` from the stream's terminal usage chunk
 * after this returns (preserving original engine behavior).
 */
export function buildResponseFromChunks(chunks: StreamChunk[]): CreateMessageResponse {
  const accumulator = new StreamAccumulator()

  for (const chunk of chunks) {
    accumulator.addChunk(chunk)
  }

  return accumulator.buildResponse()
}

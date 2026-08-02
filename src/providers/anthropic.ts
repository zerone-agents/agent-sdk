/**
 * Anthropic Messages API Provider
 *
 * Wraps the @anthropic-ai/sdk client. Since our internal format is
 * Anthropic-like, this is mostly a thin pass-through.
 */

import Anthropic from '@anthropic-ai/sdk'
import type {
  LLMProvider,
  CreateMessageParams,
  CreateMessageResponse,
  StreamChunk,
} from './types.js'

export class AnthropicProvider implements LLMProvider {
  readonly apiType = 'anthropic-messages' as const
  private client: Anthropic

  constructor(opts: { apiKey?: string; baseURL?: string }) {
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
    })
  }

  /**
   * Ensure every assistant tool_use has a matching user tool_result.
   * Insert placeholder tool_results for any missing responses.
   * This prevents API errors when transcript is inconsistent (e.g. after
   * mid-stream abort, context compaction, or resume from corrupted session).
   */
  private ensureToolCallResponses(messages: Anthropic.MessageParam[]): void {
    for (let j = messages.length - 1; j >= 0; j--) {
      const msg = messages[j]
      if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue

      // Collect tool_use ids from this assistant message
      const toolUseIds: string[] = []
      for (const block of msg.content) {
        if ((block as any).type === 'tool_use' && (block as any).id) {
          toolUseIds.push((block as any).id)
        }
      }
      if (toolUseIds.length === 0) continue

      // Check which tool_use ids have responses in subsequent user messages
      const respondedIds = new Set<string>()
      for (let k = j + 1; k < messages.length; k++) {
        const next = messages[k]
        // Stop at next assistant message — tool_results must follow immediately
        if (next.role === 'assistant') break
        if (next.role !== 'user' || !Array.isArray(next.content)) continue
        for (const block of next.content) {
          if ((block as any).type === 'tool_result' && (block as any).tool_use_id) {
            respondedIds.add((block as any).tool_use_id)
          }
        }
      }

      // Insert placeholder tool_results for missing ids
      const missing = toolUseIds.filter(id => !respondedIds.has(id))
      if (missing.length > 0) {
        console.log(`[Anthropic] ensureToolCallResponses: inserting ${missing.length} placeholder(s) for: ${missing.join(', ')}`)
        const placeholderContent = missing.map(id => ({
          type: 'tool_result' as const,
          tool_use_id: id,
          content: 'Tool execution result was lost during context compaction.',
        }))
        messages.splice(j + 1, 0, {
          role: 'user' as const,
          content: placeholderContent as any,
        })
      }
    }
  }

  async createMessage(params: CreateMessageParams): Promise<CreateMessageResponse> {
    const messages = params.messages as Anthropic.MessageParam[]
    this.ensureToolCallResponses(messages)

    const requestParams: Anthropic.MessageCreateParamsNonStreaming = {
      model: params.model,
      max_tokens: params.maxTokens,
      system: params.system,
      messages,
      tools: params.tools
        ? (params.tools as Anthropic.Tool[])
        : undefined,
    }

    if (params.thinking?.type === 'enabled' && params.thinking.budget_tokens) {
      (requestParams as any).thinking = {
        type: 'enabled',
        budget_tokens: params.thinking.budget_tokens,
      }
    }

    if (params.effort) {
      ;(requestParams as any).output_config = { effort: params.effort }
    }

    const response = await this.client.messages.create(requestParams, {
      signal: params.signal,
    })

    return {
      content: response.content as CreateMessageResponse['content'],
      stopReason: response.stop_reason || 'end_turn',
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        totalInputTokens:
          response.usage.input_tokens
          + ((response.usage as any).cache_read_input_tokens ?? 0)
          + ((response.usage as any).cache_creation_input_tokens ?? 0),
        cache_creation_input_tokens:
          (response.usage as any).cache_creation_input_tokens,
        cache_read_input_tokens:
          (response.usage as any).cache_read_input_tokens,
      },
      rawUsage: response.usage,
    }
  }

  async *createMessageStream(params: CreateMessageParams): AsyncGenerator<StreamChunk> {
    const messages = params.messages as Anthropic.MessageParam[]
    this.ensureToolCallResponses(messages)

    const requestParams: Anthropic.MessageCreateParamsStreaming = {
      model: params.model,
      max_tokens: params.maxTokens,
      system: params.system,
      messages,
      tools: params.tools
        ? (params.tools as Anthropic.Tool[])
        : undefined,
      stream: true,
    }

    if (params.thinking?.type === 'enabled' && params.thinking.budget_tokens) {
      (requestParams as any).thinking = {
        type: 'enabled',
        budget_tokens: params.thinking.budget_tokens,
      }
    }

    if (params.effort) {
      ;(requestParams as any).output_config = { effort: params.effort }
    }

    const stream = await this.client.messages.create(requestParams, {
      signal: params.signal,
    })

    const toolInputs: Map<number, string> = new Map()
    const toolUseIds: Map<number, string> = new Map()

    for await (const event of stream) {
      if ((event as any).type === 'error') {
        const error = (event as any).error
        const err: any = new Error(`Anthropic SSE error: ${error?.type} - ${error?.message}`)
        err.status = 200
        err.error = error
        throw err
      }

      if (event.type === 'message_start') {
        const usage = (event as any).message?.usage
        if (usage) {
          yield {
            type: 'usage',
            index: -1,
            usage: {
              input_tokens: usage.input_tokens || 0,
              output_tokens: 0,
              totalInputTokens:
                (usage.input_tokens || 0)
                + (usage.cache_read_input_tokens ?? 0)
                + (usage.cache_creation_input_tokens ?? 0),
              cache_creation_input_tokens: usage.cache_creation_input_tokens,
              cache_read_input_tokens: usage.cache_read_input_tokens,
            },
          }
        }
      }

      if (event.type === 'message_delta') {
        const usage = (event as any).usage
        if (usage) {
          yield {
            type: 'usage',
            index: -1,
            usage: {
              input_tokens: usage.input_tokens || 0,
              output_tokens: usage.output_tokens || 0,
              totalInputTokens:
                (usage.input_tokens || 0)
                + (usage.cache_read_input_tokens ?? 0)
                + (usage.cache_creation_input_tokens ?? 0),
              cache_creation_input_tokens: usage.cache_creation_input_tokens,
              cache_read_input_tokens: usage.cache_read_input_tokens,
            },
            rawUsage: usage,
          }
        }
      }

      if (event.type === 'content_block_start') {
        if (event.content_block.type === 'tool_use') {
          const toolId = (event.content_block as any).id || ''
          toolUseIds.set(event.index, toolId)
          yield {
            type: 'tool_use',
            index: event.index,
            id: toolId,
            name: event.content_block.name,
            input: '',
          }
        }
      }
      
      if (event.type === 'content_block_delta') {
        const delta = event.delta
        
        if (delta.type === 'text_delta') {
          yield {
            type: 'text',
            index: event.index,
            delta: delta.text,
          }
        }
        
        if (delta.type === 'thinking_delta') {
          yield {
            type: 'thinking',
            index: event.index,
            delta: delta.thinking,
          }
        }
        
        if (delta.type === 'input_json_delta') {
          const existing = toolInputs.get(event.index) || ''
          toolInputs.set(event.index, existing + delta.partial_json)
        }
      }
      
      if (event.type === 'content_block_stop') {
        if (toolInputs.has(event.index)) {
          yield {
            type: 'tool_use',
            index: event.index,
            id: toolUseIds.get(event.index) || '',
            input: toolInputs.get(event.index),
          }
          toolInputs.delete(event.index)
          toolUseIds.delete(event.index)
        }
      }
    }

    yield { type: 'done', index: -1 }
  }
}
/**
 * LLM Provider Factory
 *
 * Creates the appropriate provider based on API type configuration.
 */

export type { ApiType, LLMProvider, CreateMessageParams, CreateMessageResponse, NormalizedMessageParam, NormalizedContentBlock, NormalizedTool, NormalizedResponseBlock, StreamChunk } from './types.js'

export { AnthropicProvider } from './anthropic.js'
export { OpenAIProvider } from './openai.js'

import type { ApiType, LLMProvider } from './types.js'
import { AnthropicProvider } from './anthropic.js'
import { OpenAIProvider } from './openai.js'

/**
 * Create an LLM provider based on the API type.
 *
 * @param apiType - 'anthropic-messages' or 'openai-completions'
 * @param opts - API credentials (apiKey/baseURL), diagnostics sink, and the
 *   OpenAI-path legacyMaxTokens compatibility flag
 */
export function createProvider(
  apiType: ApiType,
  opts: {
    apiKey?: string
    baseURL?: string
    diagnostics?: import('../utils/diagnostics.js').DiagnosticsSink
    /** #142: OpenAI path only — send legacy `max_tokens` instead of `max_completion_tokens`. Ignored by the Anthropic provider. */
    legacyMaxTokens?: boolean
  },
): LLMProvider {
  switch (apiType) {
    case 'anthropic-messages':
      return new AnthropicProvider(opts)
    case 'openai-completions':
      return new OpenAIProvider(opts)
    default:
      throw new Error(`Unsupported API type: ${apiType}. Use 'anthropic-messages' or 'openai-completions'.`)
  }
}

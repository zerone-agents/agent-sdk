/**
 * WebFetchTool - Fetch web content via provider chain.
 *
 * Default: anonymous Jina (handles JS rendering) → local fallback (readability + turndown).
 * Configure via ToolServices.webFetch to override providers.
 *
 * See docs/superpowers/specs/2026-08-03-webfetch-enhancements-design.md.
 */

import { defineTool } from './types.js'
import {
  buildProviders,
  type WebFetchConfig,
  type FetchMetadata,
} from './web-fetch-providers.js'

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_CHARS = 100_000

export const WebFetchTool = defineTool({
  name: 'WebFetch',
  description:
    'Fetch content from a URL and return it as text. Supports HTML pages, JSON APIs, and plain text. Strips HTML tags for readability.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch content from',
      },
      headers: {
        type: 'object',
        description:
          'Optional HTTP headers (overrides default User-Agent). Applied only to local provider; ignored by cloud providers (Jina/Firecrawl).',
      },
      format: {
        type: 'string',
        enum: ['markdown', 'text', 'html'],
        description:
          "Output format. Default 'markdown' (readability-extracted, LLM-friendly). Use 'text' for plain text, 'html' for raw HTML.",
      },
      maxChars: {
        type: 'number',
        description:
          'Max characters in response. Default 100000. Truncated with ...(truncated) suffix.',
      },
    },
    required: ['url'],
  },
  isReadOnly: true,
  isConcurrencySafe: true,
  async call(input, context) {
    const { url, headers, format, maxChars } = input

    const config: WebFetchConfig | undefined = context.services?.webFetch
    const timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const deadlineMs = Date.now() + timeoutMs

    const providers = buildProviders(config)
    if (providers.length === 0) {
      return {
        data: 'WebFetch misconfiguration: no providers available',
        is_error: true,
      }
    }

    const errors: string[] = []
    for (const provider of providers) {
      const result = await provider.fetch({
        url,
        headers,
        format,
        maxChars: maxChars ?? DEFAULT_MAX_CHARS,
        deadlineMs,
        abortSignal: context.abortSignal,
      })

      if (result.ok) {
        return formatWithMetadata(result.content, result.metadata)
      }

      errors.push(`${provider.name}: ${result.message}`)
      if (!result.retryable) {
        // non-retryable: 立刻终止 chain
        break
      }
    }

    return {
      data: `Failed to fetch ${url}. Attempts:\n${errors.map((e) => '  - ' + e).join('\n')}`,
      is_error: true,
    }
  },
})

/**
 * 拼装最终输出：元数据头 + 分隔符 + 正文。
 */
function formatWithMetadata(content: string, meta: FetchMetadata): string {
  const lines: string[] = []
  if (meta.title) lines.push(`Title: ${meta.title}`)
  lines.push(`URL: ${meta.finalUrl}`)
  lines.push(`Content-Type: ${meta.contentType}`)
  lines.push(`Provider: ${meta.provider}`)
  lines.push(`Extracted: ${meta.extracted}`)
  lines.push(`Length: ${meta.contentLength} chars`)
  return lines.join('\n') + '\n\n──────\n\n' + content
}

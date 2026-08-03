/**
 * WebFetch provider abstraction.
 *
 * Three provider types: Jina (cloud, default anonymous), Local (static HTML
 * → Markdown via readability+turndown+linkedom), Firecrawl (paid cloud).
 *
 * See docs/superpowers/specs/2026-08-03-webfetch-enhancements-design.md.
 */

import { Readability } from '@mozilla/readability'
import TurndownService from 'turndown'
import { DOMParser } from 'linkedom'

/** 单次 fetch 的请求选项 */
export interface FetchOptions {
  url: string
  /** 用户自定义 headers（仅 local provider 生效，云 provider 忽略） */
  headers?: Record<string, string>
  /** 输出格式，默认 'markdown' */
  format?: 'markdown' | 'text' | 'html'
  /** 最大字符数，默认 100_000 */
  maxChars?: number
  /** 总 deadline（ms epoch），由外部传入 */
  deadlineMs: number
  abortSignal?: AbortSignal
}

/** Provider 返回的元数据 */
export interface FetchMetadata {
  title?: string
  /** 重定向后的最终 URL */
  finalUrl: string
  contentType: string
  contentLength: number
  /** 'jina' | 'local' | 'firecrawl' */
  provider: string
  /** 是否做了正文提取 */
  extracted: boolean
}

/** Provider 统一返回类型（discriminated union） */
export type FetchResult =
  | { ok: true; content: string; metadata: FetchMetadata }
  | { ok: false; retryable: boolean; message: string }

/** Provider 接口 */
export interface WebFetchProvider {
  readonly name: string
  fetch(opts: FetchOptions): Promise<FetchResult>
}

// ─── Provider 配置 ────────────────────────────────────────────
export interface JinaProviderConfig {
  provider: 'jina'
  /** 缺省匿名（20 RPM）；有 key 500 RPM */
  apiKey?: string
  /** 默认 https://r.jina.ai */
  endpoint?: string
}

export interface LocalProviderConfig {
  provider: 'local'
}

export interface FirecrawlProviderConfig {
  provider: 'firecrawl'
  apiKey: string
  /** 默认 https://api.firecrawl.dev */
  endpoint?: string
}

export type WebFetchProviderConfig =
  | JinaProviderConfig
  | LocalProviderConfig
  | FirecrawlProviderConfig

export interface WebFetchConfig {
  /** 有序 provider 列表；空/undefined 等价于默认 [jina, local] */
  providers?: WebFetchProviderConfig[]
  /** 总超时（共享），默认 30000 */
  timeoutMs?: number
}

// ─── 编码处理 ───────────────────────────────────────────────
/** 从 Content-Type header 提取 charset */
function charsetFromContentType(ct: string): string | null {
  const m = /charset\s*=\s*["']?([\w-]+)/i.exec(ct)
  return m ? m[1].toLowerCase() : null
}

/** 从 HTML <meta charset="..."> 或 <meta http-equiv> 提取 charset */
function charsetFromHtml(html: string): string | null {
  // 优先 <meta charset="...">
  const m1 = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(html)
  if (m1) return m1[1].toLowerCase()
  // 其次 http-equiv Content-Type
  const m2 = /<meta[^>]+http-equiv\s*=\s*["']?content-type["']?[^>]*content\s*=\s*["'][^"']*charset=([\w-]+)/i.exec(
    html,
  )
  if (m2) return m2[1].toLowerCase()
  return null
}

/**
 * 用正确的 charset 解码 buffer。
 * 优先级：HTTP Content-Type > HTML <meta charset> > 默认 utf-8
 * 仅用 HTML 前 1KB 探测 charset（避免对大文件全文扫描）。
 */
function decodeBuffer(
  buf: ArrayBuffer,
  contentType: string,
): { text: string; charset: string } {
  const bytes = new Uint8Array(buf)
  // 先用 ascii-superset 探测 charset
  const head = new TextDecoder('utf-8', { fatal: false }).decode(
    bytes.subarray(0, Math.min(bytes.length, 1024)),
  )
  const charset =
    charsetFromContentType(contentType) ??
    charsetFromHtml(head) ??
    'utf-8'
  try {
    const text = new TextDecoder(charset, { fatal: false }).decode(bytes)
    return { text, charset }
  } catch {
    // 不支持的 charset，回退 utf-8
    const text = new TextDecoder('utf-8').decode(bytes)
    return { text, charset: 'utf-8' }
  }
}

// ─── LocalProvider ───────────────────────────────────────────
const DEFAULT_MAX_CHARS = 100_000
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; AgentSDK/1.0)'

export class LocalProvider implements WebFetchProvider {
  readonly name = 'local'
  // 当前 LocalProviderConfig 无配置项；保留 constructor 形态以与 Jina/Firecrawl 一致
  constructor(_cfg: LocalProviderConfig) {}

  async fetch(opts: FetchOptions): Promise<FetchResult> {
    const remainingMs = opts.deadlineMs - Date.now()
    if (remainingMs <= 0) {
      return {
        ok: false,
        retryable: true,
        message: 'Local fetch timeout',
      }
    }

    const signals: AbortSignal[] = [AbortSignal.timeout(remainingMs)]
    if (opts.abortSignal) signals.push(opts.abortSignal)

    let response: Response
    try {
      response = await fetch(opts.url, {
        headers: {
          'User-Agent': DEFAULT_USER_AGENT,
          Accept: 'text/html,application/json,text/plain,*/*',
          ...opts.headers,
        },
        signal: AbortSignal.any(signals),
      })
    } catch (err: any) {
      if (opts.abortSignal?.aborted) {
        return { ok: false, retryable: false, message: 'Fetch aborted' }
      }
      return {
        ok: false,
        retryable: true,
        message: `Local fetch error: ${err.message}`,
      }
    }

    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500
      return {
        ok: false,
        retryable,
        message: `Local fetch HTTP ${response.status} ${response.statusText}`,
      }
    }

    const contentType = response.headers.get('content-type') ?? ''
    const finalUrl = response.url || opts.url

    // Wrap body read + all subsequent parse/decode/conversion steps to
    // preserve the "provider never throws" contract. Body reads can fail
    // mid-download (network drop, AbortSignal.timeout during read); parse
    // steps can also throw on malformed input. All are wrapped here so
    // callers only ever see FetchResult, never a thrown exception.
    try {
      const buf = await response.arrayBuffer()
      const { text } = decodeBuffer(buf, contentType)

      const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS
      const format = opts.format ?? 'markdown'

      // 非 HTML 内容：直接返回文本
      const isHtml =
        contentType.includes('text/html') ||
        contentType.includes('application/xhtml')
      if (!isHtml) {
        const content = truncate(text, maxChars)
        return {
          ok: true,
          content,
          metadata: {
            finalUrl,
            contentType,
            contentLength: text.length,
            provider: this.name,
            extracted: false,
          },
        }
      }

      // format: html → 跳过提取，返回原始 HTML
      if (format === 'html') {
        const content = truncate(text, maxChars)
        return {
          ok: true,
          content,
          metadata: {
            finalUrl,
            contentType,
            contentLength: text.length,
            provider: this.name,
            extracted: false,
            title: extractTitle(text),
          },
        }
      }

      // HTML → DOM → Readability → Turndown/Text
      let articleTitle: string | undefined
      let mainHtml: string
      let extracted = false
      try {
        const doc = new DOMParser().parseFromString(text, 'text/html') as any
        // linkedom's typings declare doc.title as HTMLTitleElement but at
        // runtime it returns a string (matching HTML spec); coerce for safety.
        const docTitle: string | undefined = doc.title
          ? String(doc.title)
          : undefined
        articleTitle = docTitle || undefined
        const reader = new Readability(doc)
        const article = reader.parse()
        if (article) {
          mainHtml = article.content ?? ''
          articleTitle = articleTitle ?? article.title ?? undefined
          extracted = true
        } else {
          mainHtml = text
        }
      } catch {
        // 解析失败 → 退化到原始 HTML
        mainHtml = text
      }

      let content: string
      if (format === 'text') {
        // 剥标签保留 textContent
        content = stripTags(mainHtml)
      } else {
        // markdown
        try {
          const turndown = new TurndownService({
            headingStyle: 'atx',
            codeBlockStyle: 'fenced',
          })
          content = turndown.turndown(mainHtml)
        } catch {
          content = stripTags(mainHtml)
        }
      }

      content = truncate(content, maxChars)

      return {
        ok: true,
        content,
        metadata: {
          title: articleTitle,
          finalUrl,
          contentType,
          contentLength: content.length,
          provider: this.name,
          extracted,
        },
      }
    } catch (err: any) {
      return {
        ok: false,
        retryable: true,
        message: `Local fetch body read/parse error: ${err.message}`,
      }
    }
  }
}

// ─── 工具函数 ───────────────────────────────────────────────
function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars) + '\n...(truncated)'
}

function extractTitle(html: string): string | undefined {
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html)
  return m ? m[1].trim() : undefined
}

function stripTags(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// ─── JinaProvider ────────────────────────────────────────────
const JINA_DEFAULT_ENDPOINT = 'https://r.jina.ai'

export class JinaProvider implements WebFetchProvider {
  readonly name = 'jina'
  private readonly endpoint: string
  private readonly apiKey?: string

  constructor(cfg: JinaProviderConfig) {
    this.endpoint = cfg.endpoint ?? JINA_DEFAULT_ENDPOINT
    this.apiKey = cfg.apiKey
  }

  async fetch(opts: FetchOptions): Promise<FetchResult> {
    const remainingMs = opts.deadlineMs - Date.now()
    if (remainingMs <= 0) {
      return { ok: false, retryable: true, message: 'Jina timeout' }
    }

    const targetUrl = `${this.endpoint}/${opts.url}`
    const headers: Record<string, string> = {
      Accept: 'text/markdown',
    }
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`

    const signals: AbortSignal[] = [AbortSignal.timeout(remainingMs)]
    if (opts.abortSignal) signals.push(opts.abortSignal)

    let response: Response
    try {
      response = await fetch(targetUrl, {
        headers,
        signal: AbortSignal.any(signals),
      })
    } catch (err: any) {
      if (opts.abortSignal?.aborted) {
        return { ok: false, retryable: false, message: 'Jina fetch aborted' }
      }
      return {
        ok: false,
        retryable: true,
        message: `Jina fetch error: ${err.message}`,
      }
    }

    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500
      return {
        ok: false,
        retryable,
        message: `Jina HTTP ${response.status} ${response.statusText}`,
      }
    }

    // Wrap body read + parse to preserve the "provider never throws" contract
    // (Task 2 lesson: response.text() can throw on network drop or
    // AbortSignal.timeout firing mid-read; parseJinaResponse is also covered
    // for safety on malformed input).
    try {
      const text = await response.text()
      const parsed = parseJinaResponse(text, opts.url)
      const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS

      return {
        ok: true,
        content: truncate(parsed.content, maxChars),
        metadata: {
          title: parsed.title,
          finalUrl: opts.url,
          contentType: 'text/markdown',
          contentLength: parsed.content.length,
          provider: this.name,
          extracted: true,
        },
      }
    } catch (err: any) {
      return {
        ok: false,
        retryable: true,
        message: `Jina body read/parse error: ${err.message}`,
      }
    }
  }
}

/**
 * Jina Reader 响应格式：
 *   Title: <title>
 *
 *   URL Source: <url>
 *
 *   Markdown Content:
 *   <实际内容>
 *
 * 也可能直接返回纯 markdown（无前缀块）。
 */
function parseJinaResponse(
  text: string,
  _originalUrl: string,
): { title?: string; content: string } {
  // 提取 Title: 行
  const titleMatch = /^Title:\s*(.+)$/m.exec(text)
  const title = titleMatch ? titleMatch[1].trim() : undefined

  // 提取 "Markdown Content:" 之后的内容；找不到则用全文
  const mdIdx = text.indexOf('Markdown Content:')
  let content: string
  if (mdIdx >= 0) {
    content = text.slice(mdIdx + 'Markdown Content:'.length).trim()
  } else {
    content = text.trim()
  }

  return { title, content }
}

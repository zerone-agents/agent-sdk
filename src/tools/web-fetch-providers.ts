/**
 * WebFetch provider abstraction.
 *
 * Three provider types: Jina (cloud, default anonymous), Local (static HTML
 * → Markdown via readability+turndown+linkedom), Firecrawl (paid cloud).
 *
 * See docs/superpowers/specs/2026-08-03-webfetch-enhancements-design.md.
 */

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

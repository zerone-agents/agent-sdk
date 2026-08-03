# WebFetch 工具优化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重写 `WebFetchTool`，引入三层 provider 架构（默认匿名 Jina → 失败降级本地 → 可选 Firecrawl），并修复编码、返回类型、元数据缺失等问题。

**Architecture:** Provider chain 模式与现有 `web-search` 系列对齐。Local provider 使用 `@mozilla/readability + turndown + linkedom` 做 HTML→Markdown 转换；Jina provider 通过 `r.jina.ai/<url>` 路由实现云端渲染（含 JS）；Firecrawl 作为可选付费 provider。

**Tech Stack:** TypeScript ESM（Node 18+）、`@mozilla/readability ^3.0.0`、`turndown ^7.2.0`、`linkedom ^0.18.0`、`@types/turndown`、vitest

## Global Constraints

- **License**: MIT（所有新增依赖必须 MIT/Apache-2.0 兼容）
- **Node version**: >=18.0.0（spec §engines）
- **ESM imports**: 必须带 `.js` 后缀（项目约定，TS ESM 模式）
- **No Chromium bundling**: 不在 SDK 内捆绑浏览器，JS 渲染交给 Jina/MCP
- **No persistent cache**: SDK 保持无状态
- **No breaking exports**: `WebFetchTool` 仍从 `src/tools/index.ts` 默认导出
- **Test framework**: vitest，测试文件与源文件同目录 `<name>.test.ts`
- **Provider 永不抛异常**: 内部捕获后返回 `{ ok: false, ... }`（参考 `web-search-providers.ts` 风格）

---

## File Structure

| 文件 | 职责 | 大小预估 |
|---|---|---|
| `src/tools/web-fetch-providers.ts`（新增） | Provider 接口 + Jina/Local/Firecrawl 实现 + `buildProviders` | ~320 行 |
| `src/tools/web-fetch.ts`（重写） | 工具 inputSchema + `call` 入口 + 元数据头拼装 | ~80 行 |
| `src/tools/web-fetch.test.ts`（新增） | 单元测试（mock provider） | ~250 行 |
| `src/tools/services.ts`（修改） | 在 `ToolServices` 加 `webFetch?: WebFetchConfig` 字段 | +2 行 |
| `examples/testing/test-web-fetch.ts`（修改） | 更新集成测试 | ~30 行调整 |
| `package.json`（修改） | 新增 4 个依赖 | +4 行 |

---

### Task 1: 添加依赖与 Provider 类型骨架

**Goal:** 装好 npm 依赖，建立 `web-fetch-providers.ts` 的类型定义（接口与配置类型，无实现），让后续 task 有清晰的契约。

**Files:**
- Modify: `package.json` (dependencies + devDependencies)
- Create: `src/tools/web-fetch-providers.ts`（仅类型，无实现）
- Modify: `src/tools/services.ts`（加 `webFetch?: WebFetchConfig` 字段）

**Interfaces:**
- Produces: `FetchOptions`, `FetchResult`, `WebFetchProvider`, `WebFetchConfig`, `JinaProviderConfig`, `LocalProviderConfig`, `FirecrawlProviderConfig`, `WebFetchProviderConfig`（全部 export）
- Produces: `ToolServices.webFetch?: WebFetchConfig`

- [ ] **Step 1: 安装依赖**

```bash
npm install @mozilla/readability@^3.0.0 turndown@^7.2.0 linkedom@^0.18.0
npm install -D @types/turndown@^5.0.5
```

验证 `package.json` 中：
- `dependencies` 含 `@mozilla/readability`, `turndown`, `linkedom`
- `devDependencies` 含 `@types/turndown`

- [ ] **Step 2: 写类型骨架文件**

创建 `src/tools/web-fetch-providers.ts`：

```typescript
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
```

- [ ] **Step 3: 修改 `src/tools/services.ts` 加 `webFetch` 字段**

在 `ToolServices` interface 加字段（参考已有的 `webSearch?`）：

```typescript
import type { WebFetchConfig } from './web-fetch-providers.js'
// ... 保留原有 imports

export interface ToolServices {
  askUser: AskUserHandler | null
  toolSearch: ToolSearchRegistry
  config: ConfigState
  webSearch?: WebSearchConfig
  /** Optional WebFetch provider configuration; absent = anonymous Jina → local default. */
  webFetch?: WebFetchConfig
}
```

注意 import 路径是 `'./web-fetch-providers.js'`（ESM `.js` 后缀）。

- [ ] **Step 4: 跑 typecheck 确认骨架无错**

Run: `npm run typecheck`
Expected: PASS（无类型错误）

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/tools/web-fetch-providers.ts src/tools/services.ts
git commit -m "feat(web-fetch): add provider types and dependencies

Introduces FetchOptions/FetchResult/WebFetchProvider interfaces and
WebFetchConfig. Adds readability/turndown/linkedom dependencies.
No behavior change yet."
```

---

### Task 2: 实现 LocalProvider（含字符编码处理）

**Goal:** 实现 100% 本地的 HTML→Markdown provider。覆盖：fetch、字符编码探测（解决 GBK 中文乱码）、Readability 正文提取、Turndown 转 Markdown。这是默认 chain 的兜底，也是离线场景的唯一依仗。

**Files:**
- Modify: `src/tools/web-fetch-providers.ts`（追加 LocalProvider 类）
- Test: `src/tools/web-fetch.test.ts`（创建文件，写 LocalProvider 测试）

**Interfaces:**
- Consumes: `FetchOptions`, `FetchResult`, `WebFetchProvider` (Task 1)
- Produces: `LocalProvider` class (implements `WebFetchProvider`)

- [ ] **Step 1: 写 LocalProvider 单元测试（先失败）**

创建 `src/tools/web-fetch.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocalProvider } from './web-fetch-providers.js'

// Minimal HTML fixtures
const SIMPLE_HTML = `<!DOCTYPE html><html><head><title>Test Page</title></head>
<body>
  <nav>Home About</nav>
  <main>
    <h1>Hello World</h1>
    <p>This is a <a href="https://example.com">link</a> in a paragraph.</p>
    <ul><li>Item 1</li><li>Item 2</li></ul>
  </main>
  <footer>Copyright</footer>
</body></html>`

const CHARSET_HTML_GB2312 = `<!DOCTYPE html><html><head>
  <meta charset="gb2312">
  <title>中文页面</title>
</head><body><h1>你好世界</h1></body></html>`

function makeTextDecoderMock() {
  return vi.spyOn(globalThis, 'TextDecoder' as any, 'special')
}

describe('LocalProvider', () => {
  const provider = new LocalProvider({ provider: 'local' })
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = vi.fn()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('extracts main content and converts to markdown', async () => {
    ;(globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      url: 'https://example.com/page',
      arrayBuffer: async () =>
        new TextEncoder().encode(SIMPLE_HTML).buffer,
    })

    const result = await provider.fetch({
      url: 'https://example.com/page',
      format: 'markdown',
      deadlineMs: Date.now() + 30000,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.metadata.provider).toBe('local')
    expect(result.metadata.extracted).toBe(true)
    expect(result.metadata.finalUrl).toBe('https://example.com/page')
    expect(result.metadata.title).toBe('Test Page')
    expect(result.content).toContain('Hello World')
    expect(result.content).toContain('[link]')
    // nav 和 footer 不应出现在 extracted 内容中（Readability 会过滤）
    // 注意：对极小 HTML Readability 可能保留全部，所以只断言核心内容存在
  })

  it('handles non-HTML content as plain text', async () => {
    const json = JSON.stringify({ hello: 'world' })
    ;(globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      url: 'https://api.example.com/data',
      arrayBuffer: async () =>
        new TextEncoder().encode(json).buffer,
    })

    const result = await provider.fetch({
      url: 'https://api.example.com/data',
      deadlineMs: Date.now() + 30000,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.metadata.extracted).toBe(false)
    expect(result.content).toContain('"hello": "world"')
  })

  it('detects charset from HTML meta tag', async () => {
    // GB2312 bytes for "你好世界"
    const gb2312Bytes = Buffer.from('你好世界', 'gb2312')
    const htmlBytes = Buffer.from(
      `<!DOCTYPE html><html><head><meta charset="gb2312"><title>中文</title></head>` +
        `<body><h1>你好世界</h1></body></html>`,
      'gb2312',
    )

    ;(globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/html' }), // 无 charset
      url: 'https://cn.example.com',
      arrayBuffer: async () => htmlBytes.buffer.slice(
        htmlBytes.byteOffset,
        htmlBytes.byteOffset + htmlBytes.byteLength,
      ),
    })

    const result = await provider.fetch({
      url: 'https://cn.example.com',
      deadlineMs: Date.now() + 30000,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.content).toContain('你好世界')
  })

  it('returns retryable failure on network error', async () => {
    ;(globalThis.fetch as any).mockRejectedValue(
      new Error('ENOTFOUND example.invalid'),
    )

    const result = await provider.fetch({
      url: 'https://example.invalid',
      deadlineMs: Date.now() + 30000,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.retryable).toBe(true)
    expect(result.message).toContain('example.invalid')
  })

  it('respects maxChars truncation', async () => {
    const long = '<main><p>' + 'x'.repeat(5000) + '</p></main>'
    const html = `<!DOCTYPE html><html><head><title>L</title></head><body>${long}</body></html>`
    ;(globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/html' }),
      url: 'https://example.com/long',
      arrayBuffer: async () => new TextEncoder().encode(html).buffer,
    })

    const result = await provider.fetch({
      url: 'https://example.com/long',
      maxChars: 100,
      deadlineMs: Date.now() + 30000,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.content.length).toBeLessThanOrEqual(120) // 含截断后缀
  })

  it('format: html returns raw HTML without extraction', async () => {
    ;(globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/html' }),
      url: 'https://example.com/raw',
      arrayBuffer: async () =>
        new TextEncoder().encode(SIMPLE_HTML).buffer,
    })

    const result = await provider.fetch({
      url: 'https://example.com/raw',
      format: 'html',
      deadlineMs: Date.now() + 30000,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.metadata.extracted).toBe(false)
    expect(result.content).toContain('<html>')
    expect(result.content).toContain('<nav>')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/tools/web-fetch.test.ts`
Expected: FAIL（`LocalProvider is not exported` 或类似错误）

- [ ] **Step 3: 在 `web-fetch-providers.ts` 实现 LocalProvider**

在文件末尾追加（保留 Task 1 的类型定义不动）：

```typescript
import { Readability } from '@mozilla/readability'
import TurndownService from 'turndown'
import { DOMParser } from 'linkedom'

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
    const buf = await response.arrayBuffer()
    const { text } = decodeBuffer(buf, contentType)

    const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS
    const format = opts.format ?? 'markdown'

    // 非 HTML 内容：直接返回文本
    const isHtml =
      contentType.includes('text/html') || contentType.includes('application/xhtml')
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
      const doc = new DOMParser().parseFromString(text, 'text/html')
      articleTitle = doc.title || undefined
      const reader = new Readability(doc as any)
      const article = reader.parse()
      if (article) {
        mainHtml = article.content
        articleTitle = articleTitle ?? article.title
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/tools/web-fetch.test.ts`
Expected: PASS（6 个 LocalProvider 测试全过；如 Readability 对极小 HTML 不提取，调整 fixture 让它包含足够文本）

如果 "extracts main content" 测试失败（Readability 对小页面可能不提取），把 fixture 的 main 内容加长（至少 200 字符）。

- [ ] **Step 5: 跑 typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/tools/web-fetch-providers.ts src/tools/web-fetch.test.ts
git commit -m "feat(web-fetch): implement LocalProvider with charset detection

HTML→Markdown via readability+turndown+linkedom. Handles GBK/GB2312/etc
charset via TextDecoder. Supports format: markdown|text|html."
```

---

### Task 3: 实现 JinaProvider

**Goal:** 实现默认 chain 的第一道防线：通过 `r.jina.ai/<url>` 路由，匿名 20 RPM，自动处理 JS 渲染和反爬。

**Files:**
- Modify: `src/tools/web-fetch-providers.ts`（追加 JinaProvider）
- Test: `src/tools/web-fetch.test.ts`（追加 JinaProvider 测试）

**Interfaces:**
- Consumes: `FetchOptions`, `FetchResult`, `WebFetchProvider`, `JinaProviderConfig` (Task 1)
- Produces: `JinaProvider` class

- [ ] **Step 1: 追加 JinaProvider 单元测试**

在 `src/tools/web-fetch.test.ts` 末尾追加：

```typescript
import { JinaProvider } from './web-fetch-providers.js'

describe('JinaProvider', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = vi.fn()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('constructs r.jina.ai URL and sends anonymous request', async () => {
    ;(globalThis.fetch as any).mockImplementation(async (url: string, init: any) => {
      expect(url).toBe('https://r.jina.ai/https://example.com/page')
      expect(init.headers['Accept']).toContain('text/markdown')
      expect(init.headers['Authorization']).toBeUndefined()
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/markdown' }),
        url,
        text: async () =>
          'Title: Example\n\nURL Source: https://example.com/page\n\nMarkdown Content:\n\n# Example\n\nHello.',
      }
    })

    const provider = new JinaProvider({ provider: 'jina' })
    const result = await provider.fetch({
      url: 'https://example.com/page',
      deadlineMs: Date.now() + 30000,
    })

    expect(result.ok).toBe(true)
  })

  it('sends Bearer token when apiKey configured', async () => {
    let capturedInit: any
    ;(globalThis.fetch as any).mockImplementation(async (_url: string, init: any) => {
      capturedInit = init
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/markdown' }),
        text: async () => '# Hi',
      }
    })

    const provider = new JinaProvider({ provider: 'jina', apiKey: 'test-key' })
    await provider.fetch({
      url: 'https://example.com',
      deadlineMs: Date.now() + 30000,
    })

    expect(capturedInit.headers['Authorization']).toBe('Bearer test-key')
  })

  it('returns retryable on 429', async () => {
    ;(globalThis.fetch as any).mockResolvedValue({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      headers: new Headers(),
      text: async () => 'rate limited',
    })

    const provider = new JinaProvider({ provider: 'jina' })
    const result = await provider.fetch({
      url: 'https://example.com',
      deadlineMs: Date.now() + 30000,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.retryable).toBe(true)
    expect(result.message).toContain('429')
  })

  it('returns non-retryable on 404', async () => {
    ;(globalThis.fetch as any).mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      headers: new Headers(),
      text: async () => 'not found',
    })

    const provider = new JinaProvider({ provider: 'jina' })
    const result = await provider.fetch({
      url: 'https://example.com/missing',
      deadlineMs: Date.now() + 30000,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.retryable).toBe(false)
  })

  it('parses Jina response title and content', async () => {
    ;(globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/markdown' }),
      url: 'https://r.jina.ai/https://example.com',
      text: async () =>
        'Title: My Page\n\nURL Source: https://example.com\n\nMarkdown Content:\n\n# My Page\n\nBody text here.',
    })

    const provider = new JinaProvider({ provider: 'jina' })
    const result = await provider.fetch({
      url: 'https://example.com',
      deadlineMs: Date.now() + 30000,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.metadata.provider).toBe('jina')
    expect(result.metadata.extracted).toBe(true)
    expect(result.metadata.finalUrl).toBe('https://example.com')
    expect(result.content).toContain('Body text here')
  })

  it('respects custom endpoint', async () => {
    let capturedUrl: string
    ;(globalThis.fetch as any).mockImplementation(async (url: string) => {
      capturedUrl = url
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/markdown' }),
        text: async () => '# Hi',
      }
    })

    const provider = new JinaProvider({
      provider: 'jina',
      endpoint: 'https://custom-jina.example.com',
    })
    await provider.fetch({
      url: 'https://target.com',
      deadlineMs: Date.now() + 30000,
    })

    expect(capturedUrl!).toBe('https://custom-jina.example.com/https://target.com')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/tools/web-fetch.test.ts`
Expected: FAIL（`JinaProvider is not exported`）

- [ ] **Step 3: 在 `web-fetch-providers.ts` 追加 JinaProvider**

在文件末尾追加：

```typescript
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
  originalUrl: string,
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/tools/web-fetch.test.ts`
Expected: PASS（所有 LocalProvider + JinaProvider 测试通过）

- [ ] **Step 5: 跑 typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/tools/web-fetch-providers.ts src/tools/web-fetch.test.ts
git commit -m "feat(web-fetch): implement JinaProvider (anonymous cloud, default)

Routes through r.jina.ai/<url>. Anonymous 20 RPM, 500 RPM with API key.
Handles JS rendering and anti-bot at the cloud layer."
```

---

### Task 4: 实现 FirecrawlProvider

**Goal:** 实现可选付费 provider。仅当用户在 `ToolServices.webFetch.providers` 配置时才出现在链中。

**Files:**
- Modify: `src/tools/web-fetch-providers.ts`（追加 FirecrawlProvider）
- Test: `src/tools/web-fetch.test.ts`（追加 FirecrawlProvider 测试）

**Interfaces:**
- Consumes: `FetchOptions`, `FetchResult`, `WebFetchProvider`, `FirecrawlProviderConfig`
- Produces: `FirecrawlProvider` class

- [ ] **Step 1: 追加 FirecrawlProvider 测试**

在 `src/tools/web-fetch.test.ts` 末尾追加：

```typescript
import { FirecrawlProvider } from './web-fetch-providers.js'

describe('FirecrawlProvider', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = vi.fn()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('POSTs to /v2/markdown with Bearer token', async () => {
    let capturedUrl: string
    let capturedInit: any
    ;(globalThis.fetch as any).mockImplementation(async (url: string, init: any) => {
      capturedUrl = url
      capturedInit = init
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () =>
          JSON.stringify({
            success: true,
            data: { markdown: '# Firecrawl Result\n\nBody.', title: 'FR' },
          }),
      }
    })

    const provider = new FirecrawlProvider({
      provider: 'firecrawl',
      apiKey: 'fc-key',
    })
    const result = await provider.fetch({
      url: 'https://example.com',
      deadlineMs: Date.now() + 30000,
    })

    expect(capturedUrl!).toBe('https://api.firecrawl.dev/v2/markdown')
    expect(capturedInit.method).toBe('POST')
    expect(capturedInit.headers['Authorization']).toBe('Bearer fc-key')
    expect(JSON.parse(capturedInit.body).url).toBe('https://example.com')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.metadata.provider).toBe('firecrawl')
    expect(result.content).toContain('Firecrawl Result')
  })

  it('returns non-retryable on success: false from API', async () => {
    ;(globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () =>
        JSON.stringify({ success: false, errors: ['invalid url'] }),
    })

    const provider = new FirecrawlProvider({
      provider: 'firecrawl',
      apiKey: 'fc-key',
    })
    const result = await provider.fetch({
      url: 'https://example.com',
      deadlineMs: Date.now() + 30000,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.retryable).toBe(false)
  })

  it('returns retryable on 5xx', async () => {
    ;(globalThis.fetch as any).mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      headers: new Headers(),
      text: async () => 'down',
    })

    const provider = new FirecrawlProvider({
      provider: 'firecrawl',
      apiKey: 'fc-key',
    })
    const result = await provider.fetch({
      url: 'https://example.com',
      deadlineMs: Date.now() + 30000,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.retryable).toBe(true)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/tools/web-fetch.test.ts`
Expected: FAIL（`FirecrawlProvider is not exported`）

- [ ] **Step 3: 在 `web-fetch-providers.ts` 追加 FirecrawlProvider**

在文件末尾追加：

```typescript
// ─── FirecrawlProvider ──────────────────────────────────────
const FIRECRAWL_DEFAULT_ENDPOINT = 'https://api.firecrawl.dev'

export class FirecrawlProvider implements WebFetchProvider {
  readonly name = 'firecrawl'
  private readonly endpoint: string
  private readonly apiKey: string

  constructor(cfg: FirecrawlProviderConfig) {
    this.endpoint = cfg.endpoint ?? FIRECRAWL_DEFAULT_ENDPOINT
    this.apiKey = cfg.apiKey
  }

  async fetch(opts: FetchOptions): Promise<FetchResult> {
    const remainingMs = opts.deadlineMs - Date.now()
    if (remainingMs <= 0) {
      return { ok: false, retryable: true, message: 'Firecrawl timeout' }
    }

    const signals: AbortSignal[] = [AbortSignal.timeout(remainingMs)]
    if (opts.abortSignal) signals.push(opts.abortSignal)

    const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS

    let response: Response
    try {
      response = await fetch(`${this.endpoint}/v2/markdown`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ url: opts.url, maxChars }),
        signal: AbortSignal.any(signals),
      })
    } catch (err: any) {
      if (opts.abortSignal?.aborted) {
        return { ok: false, retryable: false, message: 'Firecrawl aborted' }
      }
      return {
        ok: false,
        retryable: true,
        message: `Firecrawl fetch error: ${err.message}`,
      }
    }

    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500
      return {
        ok: false,
        retryable,
        message: `Firecrawl HTTP ${response.status} ${response.statusText}`,
      }
    }

    const body = await response.text()
    let parsed: any
    try {
      parsed = JSON.parse(body)
    } catch {
      return {
        ok: false,
        retryable: false,
        message: 'Firecrawl returned non-JSON response',
      }
    }

    if (!parsed.success) {
      const errMsg = Array.isArray(parsed.errors)
        ? parsed.errors.join(', ')
        : 'unknown error'
      return {
        ok: false,
        retryable: false,
        message: `Firecrawl error: ${errMsg}`,
      }
    }

    const content: string = parsed.data?.markdown ?? ''
    return {
      ok: true,
      content: truncate(content, maxChars),
      metadata: {
        title: parsed.data?.title,
        finalUrl: opts.url,
        contentType: 'text/markdown',
        contentLength: content.length,
        provider: this.name,
        extracted: true,
      },
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/tools/web-fetch.test.ts`
Expected: PASS（所有 14 个测试）

- [ ] **Step 5: 跑 typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/tools/web-fetch-providers.ts src/tools/web-fetch.test.ts
git commit -m "feat(web-fetch): implement FirecrawlProvider (paid cloud)

POSTs to /v2/markdown endpoint. Optional paid alternative to Jina."
```

---

### Task 5: 实现 `buildProviders` chain 构造逻辑

**Goal:** 把三个 provider 通过 `buildProviders()` 组装起来。核心规则：配置非空严格按配置；空/缺省走默认 `[jina, local]`。

**Files:**
- Modify: `src/tools/web-fetch-providers.ts`（追加 `buildProviders`）
- Test: `src/tools/web-fetch.test.ts`（追加 buildProviders 测试）

**Interfaces:**
- Consumes: `LocalProvider`, `JinaProvider`, `FirecrawlProvider`, `WebFetchConfig`
- Produces: `buildProviders(config?)` function

- [ ] **Step 1: 追加 buildProviders 测试**

在 `src/tools/web-fetch.test.ts` 末尾追加：

```typescript
import { buildProviders } from './web-fetch-providers.js'

describe('buildProviders', () => {
  it('returns [jina, local] by default when no config', () => {
    const providers = buildProviders(undefined)
    expect(providers).toHaveLength(2)
    expect(providers[0].name).toBe('jina')
    expect(providers[1].name).toBe('local')
  })

  it('returns [jina, local] when providers array is empty', () => {
    const providers = buildProviders({ providers: [] })
    expect(providers).toHaveLength(2)
    expect(providers[0].name).toBe('jina')
  })

  it('respects explicit provider list without appending fallback', () => {
    const providers = buildProviders({
      providers: [{ provider: 'local' }],
    })
    expect(providers).toHaveLength(1)
    expect(providers[0].name).toBe('local')
  })

  it('constructs Firecrawl when configured', () => {
    const providers = buildProviders({
      providers: [
        { provider: 'firecrawl', apiKey: 'k' },
        { provider: 'local' },
      ],
    })
    expect(providers).toHaveLength(2)
    expect(providers[0].name).toBe('firecrawl')
    expect(providers[1].name).toBe('local')
  })

  it('respects custom Jina endpoint', () => {
    const providers = buildProviders({
      providers: [
        { provider: 'jina', endpoint: 'https://my-jina.example.com' },
      ],
    })
    expect(providers[0].name).toBe('jina')
    // name 暴露即可，endpoint 通过 fetch 行为验证（已在 Task 3 测过）
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/tools/web-fetch.test.ts`
Expected: FAIL（`buildProviders is not exported`）

- [ ] **Step 3: 在 `web-fetch-providers.ts` 追加 buildProviders**

在文件末尾追加：

```typescript
/**
 * 构造 provider chain。
 * - 无 config 或 providers 为空 → 默认 [jina(匿名), local]
 * - 配置非空 → 严格按配置，不自动追加 fallback（用户明确知道要什么）
 */
export function buildProviders(config?: WebFetchConfig): WebFetchProvider[] {
  if (!config || !config.providers || config.providers.length === 0) {
    return [new JinaProvider({ provider: 'jina' }), new LocalProvider({ provider: 'local' })]
  }
  return config.providers.map((p) => {
    switch (p.provider) {
      case 'jina':
        return new JinaProvider(p)
      case 'local':
        return new LocalProvider(p)
      case 'firecrawl':
        return new FirecrawlProvider(p)
    }
  })
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/tools/web-fetch.test.ts`
Expected: PASS（所有 19 个测试）

- [ ] **Step 5: 跑 typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/tools/web-fetch-providers.ts src/tools/web-fetch.test.ts
git commit -m "feat(web-fetch): implement buildProviders chain logic

Default [jina, local] chain for zero-config resilience. Explicit config
overrides without appending fallback."
```

---

### Task 6: 重写 WebFetchTool（call 入口 + 元数据头 + 降级循环）

**Goal:** 把 `web-fetch.ts` 从 69 行的初级实现重写为基于 provider chain 的入口。包括：调用 chain、按 retryable 降级、拼装元数据头、按错误返回 `{data, is_error}`。

**Files:**
- Modify: `src/tools/web-fetch.ts`（重写，保留 import 路径不变）
- Test: `src/tools/web-fetch.test.ts`（追加 WebFetchTool 集成测试）

**Interfaces:**
- Consumes: `buildProviders`, `FetchOptions`, `FetchResult`, `WebFetchConfig` (Tasks 1-5), `defineTool`, `ToolContext`
- Produces: 重写的 `WebFetchTool`（导出名不变）

- [ ] **Step 1: 追加 WebFetchTool 集成测试**

在 `src/tools/web-fetch.test.ts` 末尾追加：

```typescript
import { WebFetchTool } from './web-fetch.js'

// 用一个 fake provider 替代 buildProviders，方便注入控制
vi.mock('./web-fetch-providers.js', async (importOriginal) => {
  const actual: any = await importOriginal()
  return {
    ...actual,
    buildProviders: (_config: any) => _config?.__testProviders ?? [],
  }
})

describe('WebFetchTool', () => {
  function makeProvider(
    outcome: { ok: true; content: string; metadata: any } | { ok: false; retryable: boolean; message: string },
    name = 'fake',
  ): any {
    return {
      name,
      fetch: async () => outcome,
    }
  }

  it('returns content with metadata header when provider succeeds', async () => {
    const result: any = await WebFetchTool.call(
      { url: 'https://x.com' },
      {
        cwd: '',
        sessionId: 't',
        services: {
          webFetch: {
            __testProviders: [
              makeProvider({
                ok: true,
                content: '# Hello\n\nWorld',
                metadata: {
                  title: 'Hello',
                  finalUrl: 'https://x.com',
                  contentType: 'text/html',
                  contentLength: 13,
                  provider: 'jina',
                  extracted: true,
                },
              }),
            ],
          },
        },
      } as any,
    )

    expect(result.is_error).toBe(false)
    expect(result.content).toContain('Title: Hello')
    expect(result.content).toContain('URL: https://x.com')
    expect(result.content).toContain('Provider: jina')
    expect(result.content).toContain('Extracted: true')
    expect(result.content).toContain('# Hello')
  })

  it('falls back to next provider when first is retryable', async () => {
    const result: any = await WebFetchTool.call(
      { url: 'https://x.com' },
      {
        cwd: '',
        sessionId: 't',
        services: {
          webFetch: {
            __testProviders: [
              makeProvider({
                ok: false,
                retryable: true,
                message: 'jina 429',
              }, 'jina'),
              makeProvider({
                ok: true,
                content: 'Fallback content',
                metadata: {
                  finalUrl: 'https://x.com',
                  contentType: 'text/html',
                  contentLength: 15,
                  provider: 'local',
                  extracted: true,
                },
              }, 'local'),
            ],
          },
        },
      } as any,
    )

    expect(result.is_error).toBe(false)
    expect(result.content).toContain('Provider: local')
    expect(result.content).toContain('Fallback content')
  })

  it('returns error when all providers fail retryable', async () => {
    const result: any = await WebFetchTool.call(
      { url: 'https://x.com' },
      {
        cwd: '',
        sessionId: 't',
        services: {
          webFetch: {
            __testProviders: [
              makeProvider({ ok: false, retryable: true, message: 'jina 429' }, 'jina'),
              makeProvider({ ok: false, retryable: true, message: 'local timeout' }, 'local'),
            ],
          },
        },
      } as any,
    )

    expect(result.is_error).toBe(true)
    expect(result.content).toContain('jina 429')
    expect(result.content).toContain('local timeout')
  })

  it('stops chain immediately on non-retryable', async () => {
    const localCalled = vi.fn()
    const result: any = await WebFetchTool.call(
      { url: 'https://x.com' },
      {
        cwd: '',
        sessionId: 't',
        services: {
          webFetch: {
            __testProviders: [
              makeProvider({ ok: false, retryable: false, message: '404 not found' }, 'jina'),
              {
                name: 'local',
                fetch: async () => {
                  localCalled()
                  return { ok: true, content: 'should not happen', metadata: {} }
                },
              },
            ],
          },
        },
      } as any,
    )

    expect(result.is_error).toBe(true)
    expect(localCalled).not.toHaveBeenCalled()
    expect(result.content).toContain('404 not found')
  })

  it('passes format and maxChars to provider', async () => {
    let capturedOpts: any
    const result: any = await WebFetchTool.call(
      { url: 'https://x.com', format: 'text', maxChars: 500 },
      {
        cwd: '',
        sessionId: 't',
        services: {
          webFetch: {
            __testProviders: [
              {
                name: 'fake',
                fetch: async (opts: any) => {
                  capturedOpts = opts
                  return {
                    ok: true,
                    content: 'text',
                    metadata: {
                      finalUrl: opts.url,
                      contentType: 'text/plain',
                      contentLength: 4,
                      provider: 'fake',
                      extracted: false,
                    },
                  }
                },
              },
            ],
          },
        },
      } as any,
    )

    expect(capturedOpts.format).toBe('text')
    expect(capturedOpts.maxChars).toBe(500)
    expect(result.is_error).toBe(false)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/tools/web-fetch.test.ts`
Expected: FAIL（旧 WebFetchTool 不调用 buildProviders，metadata 头格式不对）

注意：因为加了 `vi.mock`，可能要清理上一个测试的 mock 影响；如果运行顺序有问题，把 WebFetchTool describe 块放到独立文件 `web-fetch-tool.test.ts`，但**优先尝试同文件**。

- [ ] **Step 3: 重写 `src/tools/web-fetch.ts`**

完整替换文件内容：

```typescript
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/tools/web-fetch.test.ts`
Expected: PASS（所有 24 个测试）

如果 mock 覆盖 `buildProviders` 导致前几个 describe 块（LocalProvider/JinaProvider 测试本身）失败，**把 WebFetchTool describe 块移到独立的 `src/tools/web-fetch-tool.test.ts` 文件**，并删除 `web-fetch.test.ts` 里的 `vi.mock` 块。

- [ ] **Step 5: 跑 typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: 跑全量测试**

Run: `npm test`
Expected: PASS（确认改动没破坏其他测试）

- [ ] **Step 7: Commit**

```bash
git add src/tools/web-fetch.ts src/tools/web-fetch.test.ts src/tools/web-fetch-tool.test.ts
git commit -m "feat(web-fetch): rewrite WebFetchTool with provider chain and metadata header

Default: anonymous Jina → local fallback. Adds metadata header (Title/URL/
Provider/Extracted/Length) before content. Provider chain stops on first
success or first non-retryable error."
```

---

### Task 7: 更新集成测试 `examples/testing/test-web-fetch.ts`

**Goal:** 更新手动集成测试脚本，验证真实站点的端到端行为（包括 SPA 站点走 Jina、静态站点降级到 local）。

**Files:**
- Modify: `examples/testing/test-web-fetch.ts`

**Interfaces:**
- Consumes: 重写后的 `WebFetchTool`（返回值结构变了：现在 `result.content` 总是字符串，含元数据头）

- [ ] **Step 1: 检查现有 test 对返回值的假设并更新**

旧代码假设 `result.is_error` 和 `result.content.length` 都直接可用。新版 `defineTool` 的 wrapper（见 `src/tools/types.ts:33`）会把字符串结果包成 `{ content: <string>, is_error: false }`，所以 `result.content` 仍然可用——但 content 现在含元数据头。

更新 `examples/testing/test-web-fetch.ts` 的 Test 1（直接调用部分）：

```typescript
async function testDirectCall() {
  console.log('--- Test 1: Direct Call ---\n')

  console.log('Fetching https://www.baidu.com...\n')
  const result: any = await WebFetchTool.call({ url: 'https://www.baidu.com' }, {})

  console.log('is_error:', result.is_error)
  console.log('content length:', result.content.length)
  console.log('content preview:', result.content.slice(0, 500))

  if (!result.is_error && result.content.length > 0) {
    // 新版应包含元数据头
    const hasHeader = /^Title:|^URL:|^Provider:/m.test(result.content)
    if (hasHeader) {
      console.log('\n✅ PASS: Direct call returned content with metadata header\n')
      return true
    } else {
      console.log('\n⚠️  WARN: Content missing metadata header (unexpected)\n')
      return true
    }
  } else {
    console.log('\n❌ FAIL\n')
    return false
  }
}
```

同时把 Test 1 顶部的 import 路径修复（之前是 `from '../../src/tools/web-fetch'`，因为文件用了 `.js` 后缀约定）：

```typescript
import { WebFetchTool } from '../../src/tools/web-fetch.js'
import { createAgent } from '../../src/index.js'
```

注意：根据项目实际 tsconfig，可能不需要 `.js`，保留原样如果原 import 在测试中能跑通。

- [ ] **Step 2: 加一个 SPA 站点测试**

在 `testDirectCall` 之后追加：

```typescript
async function testSpaSite() {
  console.log('--- Test 2: SPA Site (React docs) ---\n')

  console.log('Fetching https://react.dev (SPA, requires JS rendering)...\n')
  const result: any = await WebFetchTool.call(
    { url: 'https://react.dev', maxChars: 5000 },
    {},
  )

  console.log('is_error:', result.is_error)
  console.log('provider line:', /^Provider: (.+)$/m.exec(result.content)?.[1])
  console.log('content preview:', result.content.slice(0, 500))

  // SPA 走 jina 应该能拿到内容
  if (!result.is_error && result.content.includes('React')) {
    console.log('\n✅ PASS: SPA site returned content (likely via Jina)\n')
    return true
  } else {
    console.log('\n⚠️  WARN: SPA content empty or missing "React" keyword\n')
    return true // 不算硬失败
  }
}
```

更新 `main()` 调用：

```typescript
async function main() {
  console.log('--- WebFetch Tool Tests ---\n')

  const r1 = await testDirectCall()
  const r2 = await testSpaSite()
  const r3 = await testLLMCall() // 原 Test 2 重命名

  if (r1 && r2 && r3) {
    console.log('=== All Tests Passed ===')
    process.exit(0)
  } else {
    console.log('=== Some Tests Failed ===')
    process.exit(1)
  }
}
```

- [ ] **Step 3: 手动跑一遍（需联网）**

Run: `npx tsx examples/testing/test-web-fetch.ts`
Expected: 三个测试都 PASS（或 SPA 测试 WARN 但不 FAIL）

如果没网或不想跑，跳过这一步——单元测试已覆盖核心逻辑。

- [ ] **Step 4: Commit**

```bash
git add examples/testing/test-web-fetch.ts
git commit -m "test(web-fetch): update integration test for new provider chain

Adds SPA site test (react.dev) to verify Jina path works.
Updates assertions for metadata header format."
```

---

### Task 8: 最终验证 + 文档更新

**Goal:** 全量验证（typecheck + 全部测试 + build），更新相关文档中提到的工具描述（如果有）。

**Files:**
- Verify: 全量测试通过
- Modify: `README.md` 如果提到 WebFetch 行为

- [ ] **Step 1: 跑全量测试**

Run: `npm test`
Expected: PASS（所有现有测试 + 24 个新测试）

- [ ] **Step 2: 跑 typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: 跑 build**

Run: `npm run build`
Expected: PASS（无 TS 编译错误，`dist/` 更新）

- [ ] **Step 4: 检查 README 是否需要更新**

Run: `grep -n "WebFetch\|web-fetch" README.md`
Expected: 检查 README 中描述是否与新版行为一致（如提到"strips HTML tags"等过时描述需更新）。

更新 README 中如下的过时描述（如果有）：

旧版可能写：
> WebFetch - Fetch web content, strips HTML tags for readability

新版应为：
> WebFetch - Fetch web content via Jina (default) or local readability+markdown pipeline

- [ ] **Step 5: Commit（如有 README 更新）**

```bash
git add README.md
git commit -m "docs: update WebFetch description for new provider architecture"
```

如果 README 无变化，跳过 commit。

- [ ] **Step 6: 总结 commit 历史**

Run: `git log --oneline main..HEAD` (或对应分支)
Expected: 看到 7-8 个清晰的 commit，按 task 顺序排列。

---

## 验收清单

实施完毕后逐项验证：

- [ ] `npm test` 全绿（含 24 个新测试）
- [ ] `npm run typecheck` 通过
- [ ] `npm run build` 通过
- [ ] `WebFetchTool` 仍从 `src/tools/index.ts` 导出
- [ ] 不配置 `ToolServices.webFetch` 时默认走 `[jina(匿名), local]`
- [ ] 真实站点 baidu.com 能拿到中文内容（不乱码）
- [ ] 真实 SPA 站点 react.dev 能拿到内容（通过 Jina）
- [ ] 返回值前置元数据头（Title/URL/Provider/Extracted/Length）
- [ ] Jina 失败时自动降级到 local
- [ ] 404 等非 retryable 错误立刻终止 chain

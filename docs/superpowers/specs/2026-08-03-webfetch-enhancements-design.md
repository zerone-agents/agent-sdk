# WebFetch 工具优化设计

- **日期**：2026-08-03
- **作者**：brainstorming session
- **状态**：待实施
- **影响范围**：`src/tools/web-fetch.ts`（重写）、新增 `src/tools/web-fetch-providers.ts`、`package.json` 依赖、`examples/testing/test-web-fetch.ts`（更新）

## 1. 背景与动机

当前 `WebFetchTool`（`src/tools/web-fetch.ts`，69 行）实现过于初级，核心问题：

1. **JS 渲染页面几乎不可用**：纯 HTTP fetch，遇 SPA 站点（React/Vue 文档站）只能拿到空壳
2. **HTML 处理弱**：用简单正则剥标签，丢失所有语义结构（标题/列表/代码/表格）
3. **不做正文提取**：整页 nav/footer/script/广告噪声全部塞给 LLM
4. **字符编码依赖 fetch 默认**：中文站（GBK/GB2312）经常乱码
5. **返回类型不一致**：成功返回 `string`，失败返回 `{data, is_error}`，违反 `defineTool` 契约
6. **100KB / 30s 写死**：无 `maxChars`、`format` 等可调参数
7. **无重试/降级**：网络抖动直接失败
8. **无元信息**：最终 URL（重定向后）、标题、content-type 全丢失

## 2. 调研结论

### 2.1 主流 Agent 框架对比

| 框架 | JS 渲染 | HTML 处理栈 |
|---|---|---|
| opencode | ❌ 纯 HTTP | `@mozilla/readability + turndown + linkedom` |
| Claude Code | ❌ 纯 HTTP | `turndown` + Haiku 3.5 二次摘要，15min 缓存 |
| Aider | ⚠️ 可选 Playwright | `BeautifulSoup + pandoc`，httpx 失败降级 |
| Continue | ❌ 纯 HTTP | `jsdom + Readability + node-html-markdown` |
| Cursor | ✅ 独立 Browser 工具（MCP） | `@web` 仍是纯 HTTP |

**结论**：所有主流框架默认都不在核心包内捆绑 Chromium（280MB），JS 渲染通过可插拔方式（外部 API 或 MCP）解决。

### 2.2 库选型决策

- ❌ **`@zcag/readdown`**：放弃。npm 上不存在（仅在 JSR），第三方 aleclarson 在 npm 抢注，作者失联 5 个月，营销宣称"5KB 单一依赖"实际依赖 linkedom 真实体积 ~60KB，2 stars，风险过高。
- ✅ **`@mozilla/readability + turndown + linkedom`**：采用。opencode 同款，14 年算法打磨，生态最广，总体积约 1MB。

### 2.3 云 Provider 选型

| Provider | 匿名访问 | 免费 Key | 自托管 |
|---|---|---|---|
| **Jina Reader** | ✅ 20 RPM | 500 RPM | ✅ Apache-2.0 |
| Firecrawl | ❌ | 1000 credits/月 | ❌ |

Jina Reader 默认匿名可用是关键优势——零配置即用。请求格式极简：`GET https://r.jina.ai/<目标URL>`。

## 3. 设计

### 3.1 架构：三层 Provider Chain

```
┌──────────────────────────────────────────────────────────────┐
│                    WebFetchTool.call()                       │
│                                                              │
│  Provider 选择逻辑:                                          │
│    if (config.providers 非空)                                │
│       → 严格按配置走，不自动追加本地兜底                     │
│    else                                                      │
│       → 默认 [jina(匿名)] → 失败降级 → [local]               │
│                                                              │
│  共享 deadline（默认 30s），按序尝试直到成功                 │
│  Stop on first non-retryable error                           │
│                                                              │
│  ↓ (无论哪个 provider 成功，都走后处理)                      │
│                                                              │
│  Post-processor:                                            │
│  • 拼装元数据头 (Title / URL / Content-Type / Provider)      │
│  • 按 maxChars 截断                                          │
│  • 无缓存（SDK 保持无状态）                                  │
└──────────────────────────────────────────────────────────────────┘
```

**核心原则**：
- **默认零配置即用**：用户不配置任何 provider，匿名 Jina 也能开箱即用
- **本地兜底不可少**：Jina 限流/网络故障时仍能工作，SDK 永远不会"完全不可用"
- **配置即覆盖**：用户在 `ToolServices.webFetch` 配 providers 后，严格按配置走，不自动追加本地（用户明确知道自己要什么）
- **不在 tool 内做 JS 渲染**：浏览器渲染交给 MCP（Playwright MCP）

### 3.2 Provider 接口

新增 `src/tools/web-fetch-providers.ts`，与现有 `web-search-providers.ts` 风格对齐。

```typescript
// src/tools/web-fetch-providers.ts

/** 单次 fetch 的请求选项 */
export interface FetchOptions {
  url: string
  headers?: Record<string, string>        // 用户自定义 headers（仅 local provider 生效）
  format?: 'markdown' | 'text' | 'html'   // 默认 markdown
  maxChars?: number                        // 默认 100_000
  deadlineMs: number                       // 总 deadline（外部传入）
  abortSignal?: AbortSignal
}

/** 单次 fetch 的统一结果（discriminated union，永不抛异常） */
export type FetchResult =
  | {
      ok: true
      content: string                      // 已按 format 转换，已截断
      metadata: {
        title?: string
        finalUrl: string                   // 重定向后 URL
        contentType: string
        contentLength: number
        provider: string                   // 'jina' | 'local' | 'firecrawl'
        extracted: boolean                 // 是否做了正文提取
      }
    }
  | {
      ok: false
      retryable: boolean                   // true → 尝试下一个 provider
      message: string                      // 用户可见错误
    }

export interface WebFetchProvider {
  readonly name: string
  /** 执行 fetch；不得抛异常（捕获后返回 ok:false） */
  fetch(opts: FetchOptions): Promise<FetchResult>
}

// ─── Provider 配置 ────────────────────────────────────────────
export interface JinaProviderConfig {
  provider: 'jina'
  apiKey?: string                          // 缺省匿名
  endpoint?: string                        // 默认 https://r.jina.ai
}

export interface LocalProviderConfig {
  provider: 'local'
  // 当前无配置项；保留接口
}

export interface FirecrawlProviderConfig {
  provider: 'firecrawl'
  apiKey: string                           // 必填
  endpoint?: string                        // 默认 https://api.firecrawl.dev
}

export type WebFetchProviderConfig =
  | JinaProviderConfig | LocalProviderConfig | FirecrawlProviderConfig

export interface WebFetchConfig {
  /** 有序 provider 列表；空数组或 undefined 等价于默认 [jina, local] */
  providers?: WebFetchProviderConfig[]
  /** 总超时（共享）；默认 30000 */
  timeoutMs?: number
}

/** 构造 provider chain */
export function buildProviders(
  config?: WebFetchConfig
): WebFetchProvider[]
```

### 3.3 三个 Provider 实现要点

#### 3.3.1 JinaProvider
- URL 构造：`${endpoint}/${targetUrl}`，例如 `https://r.jina.ai/https://example.com`
- Headers：
  - 匿名：`Accept: text/markdown`（Jina 默认即返回 markdown）
  - 有 key：`Authorization: Bearer <apiKey>`
- 响应：直接是 markdown 文本，无需二次转换
- `metadata.extracted = true`（Jina 内部已做提取）
- `metadata.title`：从响应 `Title:` 头或正文第一行 H1 提取
- 重试判断：HTTP 429 / 5xx / 网络错误 → `retryable: true`；其他 4xx → `retryable: false`
- 特性不启用（v1）：`x-` 自定义 selector、engine 切换、screenshot

#### 3.3.2 LocalProvider
- 流程：`fetch → arrayBuffer → 编码探测 → readability 提取 → turndown 转 MD`
- 字符编码（解决中文乱码）：
  1. `response.arrayBuffer()` 而非 `.text()`
  2. 优先级：HTTP `Content-Type: charset=` → HTML `<meta charset="gb2312">` 正则提取 → 默认 UTF-8
  3. 用 Node 18+ 内置 `TextDecoder`（支持 gb2312/gbk/big5/shift_jis）
- HTML→Markdown：`linkedom` 解析为 DOM → `Readability` 提取正文 → `turndown` 转 MD
- 非 HTML 内容（JSON/XML/plain）：直接返回 text，跳过 readability
- `format: 'html'`：跳过 readability 和 turndown，返回原始 HTML
- `format: 'text'`：跳过 turndown，返回 readability 输出的 textContent
- `metadata.title`：从 `<title>` 或 readability 返回的 title
- 重试判断：所有 fetch 失败 → `retryable: true`（让链上没下一个时也是终态）

#### 3.3.3 FirecrawlProvider（可选）
- 仅当用户配置时才出现在链中
- POST `https://api.firecrawl.dev/v2/markdown`，body `{ url, maxChars }`
- Header：`Authorization: Bearer <apiKey>`
- 重试判断：同 Jina

### 3.4 工具 inputSchema（对 LLM 暴露）

```typescript
inputSchema: {
  type: 'object',
  properties: {
    url: { type: 'string', description: 'The URL to fetch content from' },
    headers: {
      type: 'object',
      description: 'Optional HTTP headers (overrides default User-Agent). Applied only to local provider; ignored by cloud providers (Jina/Firecrawl).',
    },
    format: {
      type: 'string',
      enum: ['markdown', 'text', 'html'],
      description: "Output format. Default 'markdown'. Use 'text' for plain text, 'html' for raw HTML.",
    },
    maxChars: {
      type: 'number',
      description: 'Max characters in response. Default 100000. Truncated with ...(truncated) suffix.',
    },
  },
  required: ['url'],
}
```

**故意不暴露给 LLM 的字段**：
- `timeout` / `providers` / `apiKey`：部署期决策，通过 `ToolServices.webFetch` 注入
- `selector`（CSS 选择器）：Jina 支持，语义复杂，留 v2

### 3.5 返回格式

成功时返回字符串，**前置元数据头**：

```
Title: GitHub - sst/opencode
URL: https://github.com/sst/opencode
Content-Type: text/html
Provider: jina
Extracted: true
Length: 8234 chars

──────

# opencode

opencode is an AI coding agent built for the terminal...
[markdown 正文]
```

失败时返回 `{ data: string, is_error: true, metadata?: {...} }`（与 web-search 风格一致）。

**元数据头设计依据**：
- `Provider:` 让 LLM 知道内容来源（"jina" = 已渲染 JS，可信；"local" = 静态抓取，SPA 可能不全）
- `URL:` 解决短链/重定向后 LLM 不知道真实地址的问题
- `──────` 分隔符让 LLM 容易区分元数据和正文
- 参考 opencode 实测，这种格式对 LLM 推理帮助显著

### 3.6 错误分类与降级

| 错误类型 | retryable | 行为 |
|---|---|---|
| HTTP 4xx（除 429） | false | 立刻返回，不降级 |
| HTTP 429 / 5xx | true | 降级到下一个 provider |
| 网络错误（DNS/timeout） | true | 降级 |
| Jina 返回空内容/解析失败 | true | 降级 |
| 内容超过 maxChars | 不是错误 | 截断即可 |

不引入重试退避（backoff）——交给下一个 provider 处理，简化逻辑。

### 3.7 文件结构

```
src/tools/
  web-fetch.ts                  ~80 行   工具定义（inputSchema + call 入口 + 元数据头拼装）
  web-fetch-providers.ts        ~320 行  Provider 接口 + Jina/Local/Firecrawl 实现 + buildProviders
  web-fetch.test.ts             新增    单元测试（mock provider）
```

与 `web-search.ts` + `web-search-providers.ts` 模式对齐。

## 4. 依赖变更

`package.json` 新增 dependencies：

```json
{
  "@mozilla/readability": "^3.0.0",     // ~50KB, MIT
  "turndown": "^7.2.0",                  // ~30KB, MIT
  "linkedom": "^0.18.0"                  // ~50KB (用于 readability 的 DOM 环境，替代 jsdom ~5MB)
}
```

加上 `@types/turndown` 到 devDependencies。总体积约 130KB（含子依赖约 1MB），远小于 jsdom 路线。

## 5. 向后兼容性

- **`url` + `headers` 参数**：保持不变
- **默认行为变化**：返回值前置了元数据头（破坏性）。考虑到当前实现质量过低，没有真实使用方依赖现有格式，可接受。
- **`ToolServices.webFetch` 注入点**：新增，不破坏现有 `webSearch` 字段
- **导出**：`WebFetchTool` 仍从 `src/tools/index.ts` 默认导出

## 6. 测试策略

### 6.1 单元测试（`web-fetch.test.ts`，新增）

- mock provider 验证 chain 降级逻辑（jina 失败 → local）
- mock provider 验证 non-retryable 立刻返回
- 验证 maxChars 截断行为
- 验证元数据头格式
- 验证 format: html/text/markdown 三种模式
- 验证 deadline 耗尽时的行为

### 6.2 集成测试（更新 `examples/testing/test-web-fetch.ts`）

- Test 1: 直接调用静态站点（example.com）→ 应走 jina，返回 markdown
- Test 2: 直接调用 SPA 站点（如 react 官网）→ 应走 jina，返回渲染后内容
- Test 3: 通过 LLM 调用 → 验证 tool_called + tool_success
- Test 4（可选）：模拟 jina 失败 → 验证降级到 local

## 7. 范围与非目标

### 7.1 本次范围
- 重写 `WebFetchTool`，引入三层 provider 架构
- 实现默认匿名 Jina + 本地降级
- 实现可选 Firecrawl provider（接口预留）
- 修复字符编码、返回类型一致性、元数据缺失
- 新增单元测试

### 7.2 明确非目标（留 v2 或后续）
- ❌ 内置 Playwright/Puppeteer 浏览器渲染（用 MCP 解决）
- ❌ 持久化缓存或跨会话缓存（属于商业层 agent-runtime 职责）
- ❌ 会话级缓存（用户明确要求无缓存，保持 SDK 无状态）
- ❌ CSS selector 提取（inputSchema 不暴露）
- ❌ PDF / 图片 OCR（已有独立工具或 MCP）
- ❌ Robots.txt 遵守（与当前实现一致，不引入）
- ❌ 重试退避（backoff）

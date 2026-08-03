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
    // Use literal JSON with the exact spacing the assertion checks for.
    const json = '{"hello": "world"}'
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
    // Node's Buffer.from(..., 'gb2312') is unsupported (only TextDecoder can
    // decode it), so we hand-build the GB2312 byte stream from the well-known
    // code points: 中=d6d0 文=cec4 你=c4e3 好=bac3 世=cac0 界=bde7.
    const asciiHead = Buffer.from(
      '<!DOCTYPE html><html><head><meta charset="gb2312"><title>',
      'utf-8',
    )
    const asciiMid = Buffer.from('</title></head><body><h1>', 'utf-8')
    const asciiTail = Buffer.from('</h1></body></html>', 'utf-8')
    const zhongwen = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]) // 中文
    const nihao = Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0xca, 0xc0, 0xbd, 0xe7]) // 你好世界
    const htmlBytes = Buffer.concat([
      asciiHead,
      zhongwen,
      asciiMid,
      nihao,
      asciiTail,
    ])

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

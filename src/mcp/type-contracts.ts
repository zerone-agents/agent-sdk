/**
 * Compile-time contracts for the MCP dual-selector (`type` / `transport`) PR.
 *
 * This file is NOT exported and contains no runtime behavior. Its sole purpose
 * is to fail `tsc --noEmit` if the exported `McpServerConfig` union regresses
 * and stops accepting the transport-selector combinations documented in
 * `McpStreamableHttpType`. Test files (`*.test.ts`) are excluded from tsc via
 * tsconfig.json, so the type-level assertions belong here.
 *
 * Each declaration must type-check against `McpServerConfig` WITHOUT `as any`.
 * If a future change makes `McpSseConfig.type` required again (or any other
 * variant's `type` / `transport` field), the corresponding line below fails to
 * compile and CI catches the regression.
 *
 * See: issue #14 follow-up review — "transport-only SSE config" gap.
 */

import type { McpServerConfig } from '../types.js'

// ---------------------------------------------------------------------------
// stdio
// ---------------------------------------------------------------------------

// Inferred from `command` (no selector)
const _stdioInferred: McpServerConfig = { command: 'echo', args: [] }
// Via `type` only
const _stdioType: McpServerConfig = { type: 'stdio', command: 'echo' }
// Via `transport` only
const _stdioTransport: McpServerConfig = { transport: 'stdio', command: 'echo' }
// Explicit cwd field
const _stdioWithCwd: McpServerConfig = { type: 'stdio', command: 'echo', cwd: '/srv' }

// ---------------------------------------------------------------------------
// SSE (the gap the reviewer flagged: transport-only must be valid at the type
// level, not just at runtime)
// ---------------------------------------------------------------------------

// Via `type` only
const _sseType: McpServerConfig = { type: 'sse', url: 'https://x' }
// Via `transport` only — fails to compile if McpSseConfig.type is required.
const _sseTransport: McpServerConfig = { transport: 'sse', url: 'https://x' }
// Inferred from `url` (no selector)
const _sseInferred: McpServerConfig = { url: 'https://x' }

// ---------------------------------------------------------------------------
// Streamable HTTP — three accepted aliases via either field
// ---------------------------------------------------------------------------

// Via `type` (each alias)
const _httpType1: McpServerConfig = { type: 'http', url: 'https://x' }
const _httpType2: McpServerConfig = { type: 'streamable_http', url: 'https://x' }
const _httpType3: McpServerConfig = { type: 'streamable-http', url: 'https://x' }

// Via `transport` (each alias)
const _httpTransport1: McpServerConfig = { transport: 'http', url: 'https://x' }
const _httpTransport2: McpServerConfig = { transport: 'streamable_http', url: 'https://x' }
const _httpTransport3: McpServerConfig = { transport: 'streamable-http', url: 'https://x' }

// Both selectors present and agreeing (different spellings of the same kind)
const _httpBothAgree1: McpServerConfig = {
  type: 'http',
  transport: 'streamable-http',
  url: 'https://x',
}
const _httpBothAgree2: McpServerConfig = {
  type: 'streamable_http',
  transport: 'http',
  url: 'https://x',
}

// Headers + retryPolicy + deferred: optional fields on every variant
const _httpWithExtras: McpServerConfig = {
  type: 'streamable_http',
  url: 'https://x',
  headers: { Authorization: 'Bearer t' },
  retryPolicy: { maxRetries: 2, timeoutMs: 1000 },
  deferred: false,
}

// ---------------------------------------------------------------------------
// Silence unused-binding warnings; the values themselves are irrelevant.
// The const declarations exist only for their type annotations.
// ---------------------------------------------------------------------------

void [
  _stdioInferred,
  _stdioType,
  _stdioTransport,
  _stdioWithCwd,
  _sseType,
  _sseTransport,
  _sseInferred,
  _httpType1,
  _httpType2,
  _httpType3,
  _httpTransport1,
  _httpTransport2,
  _httpTransport3,
  _httpBothAgree1,
  _httpBothAgree2,
  _httpWithExtras,
]

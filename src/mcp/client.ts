/**
 * MCP Client - Connect to Model Context Protocol servers
 */

import type { ToolDefinition, McpServerConfig, ToolContext, ToolResult } from '../types.js'
import { truncateForCatalog } from '../tools/helpers.js'

export interface MCPConnection {
  name: string
  status: 'connected' | 'disconnected' | 'error'
  tools: ToolDefinition[]
  error?: Error | string
  close: () => Promise<void>
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TimeoutError'
  }
}

function createTimeoutSignal(timeoutMs: number, externalSignal?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  const onAbort = () => controller.abort()
  externalSignal?.addEventListener('abort', onAbort, { once: true })

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer)
      externalSignal?.removeEventListener('abort', onAbort)
    },
  }
}

/**
 * The set of `type` spellings the SDK accepts for the MCP Streamable HTTP
 * transport. `http` is retained as a backwards-compatible alias; all spellings
 * map to `StreamableHTTPClientTransport`. See issue #14.
 */
const STREAMABLE_HTTP_TYPES = new Set(['http', 'streamable_http', 'streamable-http'])

/**
 * Resolve a single raw selector value to a normalized transport kind, or
 * `undefined` if the value is not a recognized spelling.
 */
function normalizeKind(value: string | undefined): 'stdio' | 'sse' | 'streamable-http' | undefined {
  if (value === undefined) return undefined
  if (value === 'stdio') return 'stdio'
  if (value === 'sse') return 'sse'
  if (STREAMABLE_HTTP_TYPES.has(value)) return 'streamable-http'
  return undefined
}

/**
 * Resolve a user-supplied MCP config to a normalized transport kind, applying
 * alias normalization, dual-field (`type` / `transport`) selection, and
 * omitted-type inference:
 *
 *   - `stdio`            → 'stdio'
 *   - `sse`              → 'sse' (legacy HTTP+SSE transport)
 *   - `http`/`streamable_http`/`streamable-http` → 'streamable-http'
 *   - omitted + `command` present → 'stdio'
 *   - omitted + `url` present     → 'streamable-http'
 *
 * The selector may be supplied via either `type` or `transport`. If both are
 * present and normalize to different transport kinds, a conflict error is
 * thrown. Unknown explicit values throw a clear error so misconfiguration
 * fails fast.
 */
export function resolveTransportKind(config: McpServerConfig): 'stdio' | 'sse' | 'streamable-http' {
  const rawType = (config as any).type as string | undefined
  const rawTransport = (config as any).transport as string | undefined

  const kindFromType = normalizeKind(rawType)
  const kindFromTransport = normalizeKind(rawTransport)

  if (rawType !== undefined && kindFromType === undefined) {
    throw new Error(
      `Unsupported MCP transport type: ${rawType}. ` +
        `Supported values: 'stdio', 'sse', 'streamable_http', 'streamable-http', 'http'. ` +
        `Omit 'type' to infer from config shape (command→stdio, url→Streamable HTTP).`,
    )
  }
  if (rawTransport !== undefined && kindFromTransport === undefined) {
    throw new Error(
      `Unsupported MCP transport: ${rawTransport}. ` +
        `Supported values: 'stdio', 'sse', 'streamable_http', 'streamable-http', 'http'. ` +
        `Omit 'transport' to infer from config shape (command→stdio, url→Streamable HTTP).`,
    )
  }

  // Both present: must agree after normalization.
  if (kindFromType !== undefined && kindFromTransport !== undefined) {
    if (kindFromType !== kindFromTransport) {
      throw new Error(
        `MCP transport conflict: 'type=${rawType}' (${kindFromType}) and 'transport=${rawTransport}' (${kindFromTransport}) ` +
          `resolve to different transports. Set them to the same transport, or remove one.`,
      )
    }
    return kindFromType
  }

  // Exactly one present.
  if (kindFromType !== undefined) return kindFromType
  if (kindFromTransport !== undefined) return kindFromTransport

  // Neither present: infer from shape.
  if ((config as any).command !== undefined) return 'stdio'
  if ((config as any).url !== undefined) return 'streamable-http'
  throw new Error(
    `Cannot infer MCP transport: config has no 'type'/'transport', 'command', or 'url' field`,
  )
}

async function createTransport(name: string, config: McpServerConfig) {
  const kind = resolveTransportKind(config)

  if (kind === 'stdio') {
    const stdioConfig = config as {
      command: string
      args?: string[]
      env?: Record<string, string>
      cwd?: string
      stderr?: 'inherit' | 'ignore'
    }
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
    return new StdioClientTransport({
      command: stdioConfig.command,
      args: stdioConfig.args || [],
      env: { ...process.env, ...stdioConfig.env } as Record<string, string>,
      // Only pass cwd when explicitly set; otherwise let the MCP SDK fall
      // back to its own default (process.cwd() at spawn time).
      ...(stdioConfig.cwd ? { cwd: stdioConfig.cwd } : {}),
      // Same conditional-spread pattern: when omitted the key is not passed
      // at all, preserving the upstream default ("inherit").
      ...(stdioConfig.stderr ? { stderr: stdioConfig.stderr } : {}),
    })
  }

  if (kind === 'sse') {
    const sseConfig = config as { url: string; headers?: Record<string, string> }
    const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js')
    return new SSEClientTransport(new URL(sseConfig.url), {
      requestInit: sseConfig.headers ? { headers: sseConfig.headers } : undefined,
    } as any)
  }

  // kind === 'streamable-http'
  const httpConfig = config as { url: string; headers?: Record<string, string> }
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
  return new StreamableHTTPClientTransport(new URL(httpConfig.url), {
    requestInit: httpConfig.headers ? { headers: httpConfig.headers } : undefined,
  } as any)
}

export interface BuiltClient {
  client: any
  rawTools: any[]
  close(): Promise<void>
}

/**
 * Build a single MCP Client + transport + raw tool list for the given config.
 * Throws on failure (caller decides how to handle). On success the returned
 * object owns the underlying client/transport and must be closed by the caller.
 */
export async function buildMCPClient(
  name: string,
  config: McpServerConfig,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<BuiltClient> {
  const { signal, cleanup } = createTimeoutSignal(timeoutMs, externalSignal)

  try {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')

    const transport = await createTransport(name, config)

    const client = new Client(
      { name: `agent-sdk-${name}`, version: '1.0.0' },
      { capabilities: {} },
    )

    await client.connect(transport, { signal, timeout: timeoutMs })

    // Fetch available tools
    const toolList = await client.listTools({}, { signal, timeout: timeoutMs })
    const rawTools = toolList.tools || []

    return {
      client,
      rawTools,
      async close() {
        try {
          await client.close()
        } catch {
          // ignore close errors
        }
      },
    }
  } catch (err: any) {
    if (signal.aborted) {
      throw new TimeoutError(`MCP server "${name}" initialization timed out after ${timeoutMs}ms`)
    }
    throw err
  } finally {
    cleanup()
  }
}

async function connectOnce(
  name: string,
  config: McpServerConfig,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<MCPConnection> {
  const built = await buildMCPClient(name, config, timeoutMs, externalSignal)
  const tools: ToolDefinition[] = built.rawTools.map((mcpTool: any) =>
    createMCPToolDefinition(name, mcpTool, built.client, { deferred: config.deferred }),
  )

  return {
    name,
    status: 'connected',
    tools,
    error: undefined,
    close: () => built.close(),
  }
}

/**
 * Single-line, injection-safe representation of a log field (issue #77).
 * JSON.stringify escapes every control character (incl. \n, \r, C0/C1) and
 * adds explicit quote boundaries; over-length values are truncated. Underlying
 * Error.message never enters logs — this only sanitizes host-chosen fields
 * like the server name.
 */
export function sanitizeLogField(value: string, maxLength = 128): string {
  const s = JSON.stringify(value).replace(
    // JSON.stringify leaves C1 controls (U+0080–U+009F) and U+2028/U+2029
    // raw — all render as line breaks, so escape them explicitly (issue #81).
    /[\u0080-\u009f\u2028\u2029]/g,
    (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'),
  )
  return s.length > maxLength ? s.slice(0, maxLength - 2) + '…"' : s
}

/**
 * Stable, non-sensitive error-type diagnostic for logs (issue #81, review R1).
 * NEVER derives the logged string from error-controlled data: Error.name is
 * mutable (an identifier-shaped credential like sk_live_… passes any shape
 * check) and can even be a throwing getter — which would break the
 * error-connection return contract when log-argument evaluation throws.
 * Maps to SDK-owned constants via instanceof against SDK-known classes; the
 * try/catch additionally guards instanceof traps (Proxy getPrototypeOf can
 * throw too), making this helper total.
 */
export function stableErrorType(err: unknown): string {
  try {
    if (err instanceof TimeoutError) return 'TimeoutError'
    if (err instanceof Error) return 'Error'
    return typeof err
  } catch {
    return 'Error'
  }
}

/**
 * Total error normalization for catch blocks (issue #81, review R2).
 * `err instanceof Error` and `String(err)` can BOTH throw (a revoked Proxy
 * triggers their traps) — an unprotected normalization makes the catcher
 * itself throw, breaking the error-connection return contract. The fallback
 * message is an SDK-owned constant, never derived from the thrown value.
 */
export function normalizeCaughtError(err: unknown): Error {
  try {
    if (err instanceof Error) return err
    return new Error(String(err))
  } catch {
    return new Error('connection attempt threw a non-stringifiable value')
  }
}

/**
 * Connect to an MCP server and fetch its tools.
 */
export async function connectMCPServer(
  name: string,
  config: McpServerConfig,
  externalSignal?: AbortSignal,
): Promise<MCPConnection> {
  const timeoutMs = config.retryPolicy?.timeoutMs ?? 5000
  const maxRetries = config.retryPolicy?.maxRetries ?? 0

  let lastError: Error | undefined

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await connectOnce(name, config, timeoutMs, externalSignal)
    } catch (err) {
      lastError = normalizeCaughtError(err)
      if (attempt < maxRetries) {
        console.warn('[MCP] Retrying connection', {
          server: sanitizeLogField(name),
          attempt: attempt + 2,
          maxAttempts: maxRetries + 1,
        })
      }
    }
  }

  console.error('[MCP] Failed to connect to server', {
    server: sanitizeLogField(name),
    errorType: stableErrorType(lastError),
  })
  return {
    name,
    status: 'error',
    tools: [],
    error: lastError,
    async close() {},
  }
}

/**
 * Create a ToolDefinition wrapping an MCP server tool.
 *
 * By default the returned tool is marked `deferred: true` so it opts into
 * the FindTool lazy-loading system (sub-project 2). Pass `{ deferred: false }`
 * in options to force eager loading. Per-server `deferred` overrides are
 * forwarded from connectOnce; the agent loop resolves the global default
 * for `undefined` values.
 *
 * `shortDescription` is auto-generated from `mcpTool.description` (truncated
 * via truncateForCatalog) so the deferred-tools catalog stays compact.
 * The full description is preserved in `description` for the eager schema path.
 */
export function createMCPToolDefinition(
  serverName: string,
  mcpTool: {
    name: string
    description?: string
    inputSchema?: any
    annotations?: { readOnlyHint?: boolean }
  },
  client: any,
  options?: { deferred?: boolean },
): ToolDefinition {
  const toolName = `mcp__${serverName}__${mcpTool.name}`
  const fallbackDescription = `MCP tool: ${mcpTool.name} from ${serverName}`
  const description = mcpTool.description || fallbackDescription

  return {
    name: toolName,
    description,
    // Auto-generate shortDescription from the (possibly long) description,
    // truncating with a marker so the model knows content was cut off.
    shortDescription: truncateForCatalog(description),
    // Default deferred=true unless caller overrides (sub-project 2 default).
    deferred: options?.deferred ?? true,
    inputSchema: mcpTool.inputSchema || { type: 'object', properties: {} },
    // Protocol metadata mapping (issue #72): MCP annotations.readOnlyHint
    // drives the SDK-side read-only policy (Explore subagent filtering,
    // read-only concurrency batching).
    isReadOnly: () => mcpTool.annotations?.readOnlyHint === true,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
    async prompt() {
      return mcpTool.description || ''
    },
    async call(input: any): Promise<ToolResult> {
      try {
        const result = await client.callTool({
          name: mcpTool.name,
          arguments: input,
        })

        // Extract text content from MCP result
        let output = ''
        if (result.content) {
          for (const block of result.content) {
            if (block.type === 'text') {
              output += block.text
            } else {
              output += JSON.stringify(block)
            }
          }
        } else {
          output = JSON.stringify(result)
        }

        return {
          type: 'tool_result',
          tool_use_id: '',
          content: output,
          is_error: result.isError || false,
        }
      } catch (err: any) {
        return {
          type: 'tool_result',
          tool_use_id: '',
          content: `MCP tool error: ${err.message}`,
          is_error: true,
        }
      }
    },
  }
}

/**
 * Close all MCP connections.
 */
export async function closeAllConnections(connections: MCPConnection[]): Promise<void> {
  await Promise.allSettled(connections.map((c) => c.close()))
}

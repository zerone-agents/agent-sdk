/**
 * MCP Client - Connect to Model Context Protocol servers
 */

import type { ToolDefinition, McpServerConfig, ToolContext, ToolResult } from '../types.js'

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

async function createTransport(name: string, config: McpServerConfig) {
  if (!config.type || config.type === 'stdio') {
    const stdioConfig = config as { command: string; args?: string[]; env?: Record<string, string> }
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
    return new StdioClientTransport({
      command: stdioConfig.command,
      args: stdioConfig.args || [],
      env: { ...process.env, ...stdioConfig.env } as Record<string, string>,
    })
  } else if (config.type === 'sse') {
    const sseConfig = config as { url: string; headers?: Record<string, string> }
    const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js')
    return new SSEClientTransport(new URL(sseConfig.url), {
      requestInit: sseConfig.headers ? { headers: sseConfig.headers } : undefined,
    } as any)
  } else if (config.type === 'http') {
    const httpConfig = config as { url: string; headers?: Record<string, string> }
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
    return new StreamableHTTPClientTransport(new URL(httpConfig.url), {
      requestInit: httpConfig.headers ? { headers: httpConfig.headers } : undefined,
    } as any)
  } else {
    throw new Error(`Unsupported MCP transport type: ${(config as any).type}`)
  }
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
    createMCPToolDefinition(name, mcpTool, built.client),
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
      lastError = err instanceof Error ? err : new Error(String(err))
      if (attempt < maxRetries) {
        console.warn(`[MCP] Retrying connection to "${name}" (attempt ${attempt + 2}/${maxRetries + 1})`)
      }
    }
  }

  console.error(`[MCP] Failed to connect to "${name}": ${lastError!.message}`)
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
 */
export function createMCPToolDefinition(
  serverName: string,
  mcpTool: { name: string; description?: string; inputSchema?: any },
  client: any,
): ToolDefinition {
  const toolName = `mcp__${serverName}__${mcpTool.name}`

  return {
    name: toolName,
    description: mcpTool.description || `MCP tool: ${mcpTool.name} from ${serverName}`,
    inputSchema: mcpTool.inputSchema || { type: 'object', properties: {} },
    isReadOnly: () => false,
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

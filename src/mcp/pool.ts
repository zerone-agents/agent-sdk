/**
 * MCP connection pool — reuses stdio/sse/http MCP child processes across agents
 * that share identical transport config. Reference counting + grace period
 * delays shutdown so concurrent agent startups hit a warm process.
 *
 * SDK MCP servers (in-process tools, no child process) do NOT use this pool.
 */

import { createHash } from 'crypto'
import {
  buildMCPClient,
  createMCPToolDefinition,
  type MCPConnection,
} from './client.js'
import type { McpServerConfig } from '../types.js'

const GRACE_MS = Number(process.env.ZERONE_AGENT_MCP_GRACE_MS ?? 30_000)

interface Entry {
  key: string
  built: Awaited<ReturnType<typeof buildMCPClient>>
  refCount: number
  closeTimer?: ReturnType<typeof setTimeout>
}

const pool = new Map<string, Entry>()

function configKey(config: McpServerConfig): string {
  // Hash only transport-relevant fields; retryPolicy never affects the child
  // process and must not break sharing when callers tweak it.
  const { retryPolicy: _omit, ...transport } = config as any
  return createHash('sha256').update(JSON.stringify(transport)).digest('hex').slice(0, 16)
}

/**
 * Acquire a pooled MCP connection. On a cache miss this builds (spawns) a new
 * underlying client. On a hit it reuses the existing one and bumps refCount.
 *
 * The returned `MCPConnection` carries tools named with the caller's `name`
 * prefix — so two agents configured with different `serverName` for the same
 * transport get distinct tool names while sharing one child process.
 *
 * If `buildMCPClient` throws, an `error`-status connection is returned and
 * nothing is written to the pool (so a later acquire will retry).
 */
export async function acquireMCPConnection(
  name: string,
  config: McpServerConfig,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<MCPConnection> {
  const key = configKey(config)
  const timeoutMs = opts.timeoutMs ?? config.retryPolicy?.timeoutMs ?? 5000

  let entry = pool.get(key)
  if (!entry) {
    let built: Awaited<ReturnType<typeof buildMCPClient>>
    try {
      built = await buildMCPClient(name, config, timeoutMs, opts.signal)
    } catch (err) {
      return {
        name,
        status: 'error',
        tools: [],
        error: err instanceof Error ? err : new Error(String(err)),
        async close() {},
      }
    }
    entry = { key, built, refCount: 0 }
    pool.set(key, entry)
  } else if (entry.closeTimer) {
    clearTimeout(entry.closeTimer)
    entry.closeTimer = undefined
  }

  entry.refCount++
  const tools = entry.built.rawTools.map((t) =>
    createMCPToolDefinition(name, t, entry!.built.client),
  )

  return {
    name,
    status: 'connected',
    tools,
    error: undefined,
    close() {
      return releaseByKey(key)
    },
  }
}

/**
 * Release a connection returned by `acquireMCPConnection`. Equivalent to
 * `await conn.close()` — the pool wires `close` to `releaseByKey` at acquire
 * time, so callers (e.g. `Agent.close()`) need no pool-specific knowledge.
 */
export function releaseMCPConnection(conn: MCPConnection): Promise<void> {
  return conn.close()
}

async function releaseByKey(key: string): Promise<void> {
  const entry = pool.get(key)
  if (!entry) return
  entry.refCount = Math.max(0, entry.refCount - 1)
  if (entry.refCount === 0 && !entry.closeTimer) {
    entry.closeTimer = setTimeout(() => {
      const e = pool.get(key)
      if (!e) return
      pool.delete(key)
      e.built.close().catch(() => {})
    }, GRACE_MS)
  }
}

/**
 * Test-only: forcefully drop every pooled entry (cancelling any pending close
 * timer) without waiting for the grace period.
 */
export function __clearPoolForTests(): void {
  for (const entry of pool.values()) {
    if (entry.closeTimer) clearTimeout(entry.closeTimer)
    entry.built.close().catch(() => {})
  }
  pool.clear()
}

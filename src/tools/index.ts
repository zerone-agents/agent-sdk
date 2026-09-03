/**
 * Tool Registry - All built-in tool definitions
 *
 * Tools covering file I/O, execution, search, web, agents, tasks,
 * scheduling, and more.
 */

import type { ToolDefinition } from '../types.js'
import { createDiagnosticsSink, type DiagnosticsSink } from '../utils/diagnostics.js'

// File I/O
import { BashTool } from './bash.js'
import { FileReadTool } from './read.js'
import { FileWriteTool } from './write.js'
import { FileEditTool } from './edit.js'
import { GlobTool } from './glob.js'
import { GrepTool } from './grep.js'

// Web
import { WebFetchTool } from './web-fetch.js'
import { WebSearchTool } from './web-search.js'

// Agent & Multi-agent
import { TaskTool } from './task.js'
import { MultiTaskTool } from './multi-task.js'

// User interaction
import { AskUserQuestionTool } from './ask-user.js'

// Discovery
import { FindToolTool } from './find-tool.js'

// Scheduling
import { CronCreateTool, CronDeleteTool, CronListTool } from './cron.js'

// Config
import { ConfigTool } from './config.js'

// Todo
import { TodoWriteTool } from './todowrite.js'

// Skill
import { SkillTool } from './skill.js'

/**
 * All built-in tools (20+).
 */
const ALL_TOOLS: ToolDefinition[] = [
  // Core file I/O & execution
  BashTool,
  FileReadTool,
  FileWriteTool,
  FileEditTool,
  GlobTool,
  GrepTool,

  // Web
  WebFetchTool,
  WebSearchTool,

  // Agent & Multi-agent
  TaskTool,
  MultiTaskTool,

  // User interaction
  AskUserQuestionTool,

  // Discovery
  FindToolTool,

  // Scheduling
  CronCreateTool,
  CronDeleteTool,
  CronListTool,

  // Config
  ConfigTool,

  // Todo
  TodoWriteTool,

  // Skill
  SkillTool,
]

/**
 * Get all built-in tools.
 */
export function getAllBaseTools(): ToolDefinition[] {
  return [...ALL_TOOLS]
}

/**
 * Parsed allow/deny tool list (issue #64).
 *
 * Entries are exact literals, except an entry with a trailing `*` AND a
 * non-empty prefix switches to prefix matching — `mcp__utilities__*` matches
 * every tool name starting with `mcp__utilities__`. A bare `*` is
 * side-dependent (issue #64 review round 2): on the allow side it selects
 * everything (short-circuit in applyAllowedTools); on the deny side it stays
 * a literal no-op, preserving the historical semantics of
 * `disallowedTools: ['*']` (no deny-all flip).
 */
interface ParsedToolList {
  exact: Set<string>
  /** Non-empty prefixes from trailing-* entries. */
  prefixes: string[]
  /** Trailing-* entries retained for stale-pattern diagnostics. */
  wildcards: Array<{ entry: string; prefix: string }>
}

function parseToolList(list: string[]): ParsedToolList {
  const parsed: ParsedToolList = { exact: new Set(), prefixes: [], wildcards: [] }
  for (const entry of list) {
    if (entry.endsWith('*') && entry.length > 1) {
      const prefix = entry.slice(0, -1)
      parsed.prefixes.push(prefix)
      parsed.wildcards.push({ entry, prefix })
    } else {
      parsed.exact.add(entry)
    }
  }
  return parsed
}

/** Single name matcher over a parsed list — the only wildcard consumer. */
function matchesToolList(parsed: ParsedToolList, name: string): boolean {
  if (parsed.exact.has(name)) return true
  for (const prefix of parsed.prefixes) {
    if (name.startsWith(prefix)) return true
  }
  return false
}

/** Warn once per wildcard entry that matches no tool (stale pattern). */
function warnDeadWildcardEntries(
  scope: string,
  parsed: ParsedToolList,
  toolNames: string[],
  diagnostics: DiagnosticsSink = createDiagnosticsSink(),
): void {
  for (const { entry, prefix } of parsed.wildcards) {
    if (!toolNames.some((n) => n.startsWith(prefix))) {
      diagnostics.warn(
        `[tools] ${scope} entry "${entry}" matches no tools — stale pattern or wrong server name?`,
      )
    }
  }
}

/**
 * Apply an allow-list to a tool set. Entries are exact names or trailing-`*`
 * prefixes (`mcp__srv__*`); a bare `*` selects everything. Diagnostics:
 * wildcard entries matching zero tools warn, and a non-empty allow-list that
 * filters out EVERY tool warns loudly — almost certainly misconfiguration
 * (#64).
 *
 * NOTE (source-based contract): callers decide which tools this applies to.
 * `resolveAgent()` applies it to built-in base tools ONLY — custom and MCP
 * tools bypass the allow-list by design.
 */
export function applyAllowedTools(
  tools: ToolDefinition[],
  allowedTools?: string[],
  diagnostics?: DiagnosticsSink,
): ToolDefinition[] {
  if (!allowedTools || allowedTools.length === 0) return tools

  const parsed = parseToolList(allowedTools)

  // Diagnostics run even when a bare '*' selects everything — other entries
  // alongside it can still be stale patterns (review round 3).
  warnDeadWildcardEntries('allowedTools', parsed, tools.map((t) => t.name), diagnostics)

  // Allow-side bare '*' selects everything (deny-side stays a literal —
  // see parseToolList). Other entries alongside '*' are redundant matches.
  if (allowedTools.includes('*')) return tools

  const kept = tools.filter((t) => matchesToolList(parsed, t.name))

  if (kept.length === 0 && tools.length > 0) {
    console.warn(
      `[tools] allowedTools [${allowedTools.join(', ')}] matched none of the ${tools.length} built-in tools — ` +
        `all built-ins were filtered out. The allow-list applies to built-in tools only; ` +
        `custom and MCP tools bypass it (entries are exact names or trailing-* prefixes).`,
    )
  }

  return kept
}

/**
 * Apply a deny-list to a tool set. Same entry syntax as
 * {@link applyAllowedTools}; matched tools are removed. Wildcard entries
 * matching zero tools warn as stale patterns. Diagnostics run against
 * `diagnosticPool` (defaults to `tools`) — `filterTools()` passes its
 * ORIGINAL pre-allow input so wildcards matching tools the allow-list
 * already removed are not falsely flagged stale; apply this to the full
 * merged pool so MCP patterns are never flagged stale (#64).
 */
export function applyDisallowedTools(
  tools: ToolDefinition[],
  disallowedTools?: string[],
  diagnosticPool: ToolDefinition[] = tools,
  diagnostics?: DiagnosticsSink,
): ToolDefinition[] {
  if (!disallowedTools || disallowedTools.length === 0) return tools

  const parsed = parseToolList(disallowedTools)

  warnDeadWildcardEntries('disallowedTools', parsed, diagnosticPool.map((t) => t.name), diagnostics)

  return tools.filter((t) => !matchesToolList(parsed, t.name))
}

/**
 * Filter tools by allowed/disallowed lists (allow first, then deny — deny
 * wins). Convenience composition of {@link applyAllowedTools} and
 * {@link applyDisallowedTools} over one shared set; see those for entry
 * syntax. Deny-side stale diagnostics run against the ORIGINAL input (before
 * the allow-list removed anything), so wildcards targeting allow-removed
 * tools are not falsely flagged stale. `resolveAgent()` does NOT use this —
 * it applies the lists per source (see its source-based contract).
 */
export function filterTools(
  tools: ToolDefinition[],
  allowedTools?: string[],
  disallowedTools?: string[],
): ToolDefinition[] {
  const allowed = applyAllowedTools(tools, allowedTools)
  return applyDisallowedTools(allowed, disallowedTools, tools)
}

/**
 * Assemble tool pool: merge base and MCP tools with deduplication.
 *
 * Contract (issue #64 review): merge + dedup ONLY — this helper never
 * filters. Allow/deny lists are applied per source by the caller
 * (`resolveAgent()` gates built-ins with the allow-list, bypasses custom/MCP,
 * then runs the deny-list on this merged pool).
 *
 * @deprecated Since 2.0. Filtering is now `resolveAgent`'s responsibility;
 * this helper only merges + dedupes. The allow/deny parameters are kept for
 * backward compatibility and are ignored.
 */
export function assembleToolPool(
  baseTools: ToolDefinition[],
  mcpTools: ToolDefinition[] = [],
  _allowedTools?: string[],   // unused since 2.0
  _disallowedTools?: string[], // unused since 2.0
): ToolDefinition[] {
  void _allowedTools
  void _disallowedTools
  const combined = [...baseTools, ...mcpTools]

  // Deduplicate by name (later definitions override)
  const byName = new Map<string, ToolDefinition>()
  for (const tool of combined) {
    byName.set(tool.name, tool)
  }

  return Array.from(byName.values())
}

// Re-export individual tools
export {
  // Core
  BashTool,
  FileReadTool,
  FileWriteTool,
  FileEditTool,
  GlobTool,
  GrepTool,
  WebFetchTool,
  WebSearchTool,
  // Agent
  TaskTool,
  MultiTaskTool,
  // User
  AskUserQuestionTool,
  // Discovery
  FindToolTool,
  // Scheduling
  CronCreateTool,
  CronDeleteTool,
  CronListTool,
  // Config
  ConfigTool,
  // Todo
  TodoWriteTool,
  // Skill
  SkillTool,
}

// Re-export helpers
export { defineTool, toApiTool } from './types.js'

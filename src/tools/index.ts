/**
 * Tool Registry - All built-in tool definitions
 *
 * Tools covering file I/O, execution, search, web, agents, tasks,
 * scheduling, and more.
 */

import type { ToolDefinition } from '../types.js'

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
 * Compile an allow/deny list into a name matcher (issue #64).
 *
 * Entries are exact literals, except a trailing `*` switches the entry to
 * prefix matching — `mcp__utilities__*` matches every tool whose name starts
 * with `mcp__utilities__`. A bare `*` therefore matches everything.
 */
function compileToolListMatcher(list: string[]): (name: string) => boolean {
  const exact = new Set(list.filter((e) => !e.endsWith('*')))
  const prefixes = list
    .filter((e) => e.endsWith('*'))
    .map((e) => e.slice(0, -1))
  if (prefixes.length === 0) {
    return (name) => exact.has(name)
  }
  return (name) =>
    exact.has(name) || prefixes.some((p) => name.startsWith(p))
}

/** Warn once per wildcard list entry that matches no tool (stale pattern). */
function warnDeadWildcardEntries(scope: string, list: string[], toolNames: string[]): void {
  for (const entry of list) {
    if (!entry.endsWith('*')) continue
    const prefix = entry.slice(0, -1)
    if (!toolNames.some((n) => n.startsWith(prefix))) {
      console.warn(
        `[tools] ${scope} entry "${entry}" matches no tools — stale pattern or wrong server name?`,
      )
    }
  }
}

/**
 * Filter tools by allowed/disallowed lists.
 *
 * Entries support a trailing `*` for prefix matching (e.g. `mcp__srv__*`
 * admits every tool from the `mcp__srv__` server); other entries are exact
 * literals. Diagnostics: wildcard entries matching zero tools warn, and a
 * non-empty allow-list that filters out EVERY tool warns loudly — that is
 * almost certainly misconfiguration (issue #64).
 */
export function filterTools(
  tools: ToolDefinition[],
  allowedTools?: string[],
  disallowedTools?: string[],
): ToolDefinition[] {
  let filtered = tools

  if (allowedTools && allowedTools.length > 0) {
    const matchesAllowed = compileToolListMatcher(allowedTools)
    const kept = filtered.filter((t) => matchesAllowed(t.name))

    warnDeadWildcardEntries('allowedTools', allowedTools, filtered.map((t) => t.name))

    if (kept.length === 0 && filtered.length > 0) {
      console.warn(
        `[tools] allowedTools [${allowedTools.join(', ')}] matched none of the ${filtered.length} available tools — ` +
          `all tools were filtered out and the agent has no tools. ` +
          `Entries are exact names or trailing-* prefixes (e.g. mcp__srv__*).`,
      )
    }

    filtered = kept
  }

  if (disallowedTools && disallowedTools.length > 0) {
    const matchesDisallowed = compileToolListMatcher(disallowedTools)

    warnDeadWildcardEntries('disallowedTools', disallowedTools, filtered.map((t) => t.name))

    filtered = filtered.filter((t) => !matchesDisallowed(t.name))
  }

  return filtered
}

/**
 * Assemble tool pool: base tools + MCP tools, with deduplication.
 */
export function assembleToolPool(
  baseTools: ToolDefinition[],
  mcpTools: ToolDefinition[] = [],
  allowedTools?: string[],
  disallowedTools?: string[],
): ToolDefinition[] {
  const combined = [...baseTools, ...mcpTools]

  // Deduplicate by name (later definitions override)
  const byName = new Map<string, ToolDefinition>()
  for (const tool of combined) {
    byName.set(tool.name, tool)
  }

  let tools = Array.from(byName.values())
  return filterTools(tools, allowedTools, disallowedTools)
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

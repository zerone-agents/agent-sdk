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
import { CronCreateTool, CronDeleteTool, CronListTool, initCronTools } from './cron.js'

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
 * Filter tools by allowed/disallowed lists.
 */
export function filterTools(
  tools: ToolDefinition[],
  allowedTools?: string[],
  disallowedTools?: string[],
): ToolDefinition[] {
  let filtered = tools

  if (allowedTools && allowedTools.length > 0) {
    const allowed = new Set(allowedTools)
    filtered = filtered.filter((t) => allowed.has(t.name))
  }

  if (disallowedTools && disallowedTools.length > 0) {
    const disallowed = new Set(disallowedTools)
    filtered = filtered.filter((t) => !disallowed.has(t.name))
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
  initCronTools,
  // Config
  ConfigTool,
  // Todo
  TodoWriteTool,
  // Skill
  SkillTool,
}

// Re-export helpers
export { defineTool, toApiTool } from './types.js'

/**
 * Core type definitions for the Agent SDK
 */

import type { NormalizedMessageParam } from './providers/types.js'
import type { ToolServices } from './tools/services.js'

// Content block types (provider-agnostic, compatible with Anthropic format)
export type ContentBlockParam =
  | { type: 'text'; text: string }
  | { type: 'image'; source: any }
  | { type: 'tool_use'; id: string; name: string; input: any }
  | { type: 'tool_result'; tool_use_id: string; content: string | any[]; is_error?: boolean }

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: any }
  | { type: 'thinking'; thinking: string }

// --------------------------------------------------------------------------
// Message Types
// --------------------------------------------------------------------------

export type MessageRole = 'user' | 'assistant'

export interface ConversationMessage {
  role: MessageRole
  content: string | ContentBlockParam[]
}

export interface UserMessage {
  type: 'user'
  message: ConversationMessage
  uuid: string
  timestamp: string
}

export interface AssistantMessage {
  type: 'assistant'
  message: {
    role: 'assistant'
    content: ContentBlock[]
  }
  uuid: string
  timestamp: string
  usage?: TokenUsage
  cost?: number
}

export type Message = UserMessage | AssistantMessage

// --------------------------------------------------------------------------
// SDK Message Types (streaming events)
// --------------------------------------------------------------------------

export type SDKMessage =
  | SDKUserMessage
  | SDKAssistantMessage
  | SDKToolResultMessage
  | SDKToolsCompleteMessage
  | SDKResultMessage
  | SDKPartialMessage
  | SDKSystemMessage
  | SDKCompactBoundaryMessage
  | SDKCompactMessage
  | SDKStatusMessage
  | SDKTaskNotificationMessage
  | SDKRateLimitEvent
  | SDKRetryMessage
  | SDKSubagentMessage
  | SDKSkillsUpdatedMessage
  | SDKWarningMessage

export interface SDKUserMessage {
  type: 'user'
  /** UUID of the user message just added to the conversation. */
  uuid: string
  /** When the message entered engine history — identical to the history message's timestamp. */
  timestamp: string
}

export interface SDKAssistantMessage {
  type: 'assistant'
  /** UUID of the assistant message just generated. */
  uuid: string
  session_id?: string
  /** When the message entered engine history — identical to the history message's timestamp. */
  timestamp: string
  message: {
    role: 'assistant'
    content: ContentBlock[]
  }
  parent_tool_use_id?: string | null
  usage?: TokenUsage
}

export interface SDKToolResultMessage {
  type: 'tool_result'
  result: {
    tool_use_id: string
    tool_name: string
    output: string
    /** True when the tool call failed (error, denied, aborted, etc.). */
    is_error?: boolean
    /** Structured data for UI rendering. Not sent to LLM, not persisted to transcript. */
    metadata?: unknown
  }
}

export interface SDKToolsCompleteMessage {
  type: 'tools_complete'
  /** All tool_use IDs in this batch, in block order */
  tool_use_ids: string[]
  /** Number of tool_result events emitted for this batch (should equal tool_use_ids.length) */
  tool_results_count: number
  /** Result metadata for reconciliation (no output content — that's in tool_result events) */
  results: Array<{
    tool_use_id: string
    tool_name: string
    is_error: boolean
  }>
}

export interface SDKResultMessage {
  type: 'result'
  subtype: 'success' | 'error_max_turns' | 'error_during_execution' | 'error_max_budget_usd' | string
  uuid?: string
  session_id?: string
  is_error?: boolean
  num_turns?: number
  result?: string
  stop_reason?: string | null
  total_cost_usd?: number
  duration_ms?: number
  duration_api_ms?: number
  usage?: TokenUsage
  model_usage?: Record<string, { input_tokens: number; output_tokens: number }>
  permission_denials?: Array<{ tool: string; reason: string }>
  structured_output?: unknown
  errors?: string[]
  /** Structured classification when subtype is an error (from classifyError). */
  error_type?: 'connection' | 'rate_limit' | 'overloaded' | 'server' | 'auth' | 'prompt_too_long' | 'unknown'
  /** True when the LLM stream broke mid-response and partial content was used. */
  truncated?: boolean
  /** @deprecated Use total_cost_usd */
  cost?: number
}

export interface SDKPartialMessage {
  type: 'partial_message'
  partial: {
    type: 'text' | 'thinking' | 'tool_use'
    text?: string
    tool_name?: string
    tool_use_id?: string
  }
}

/** Emitted once at session start with initialization info. */
export interface SDKSystemMessage {
  type: 'system'
  subtype: 'init'
  uuid?: string
  session_id: string
  tools: string[]
  skills?: string[]
  model: string
  cwd: string
  mcp_servers: Array<{ name: string; status: string }>
  permission_mode: string
  system_prompt?: string
}

/** Emitted when the available skills list changes. */
export interface SDKSkillsUpdatedMessage {
  type: 'system'
  subtype: 'skills_updated'
  skills: string[]
  added?: string[]
  removed?: string[]
}

/** Marks a compaction boundary in the conversation. */
export interface SDKCompactBoundaryMessage {
  type: 'system'
  subtype: 'compact_boundary'
  summary?: string
}

/** Non-fatal warning during agent execution (e.g. images stripped because model doesn't support them). */
export interface SDKWarningMessage {
  type: 'system'
  subtype: 'warning'
  message: string
}

/** Streaming events emitted during auto-compaction. */
export interface SDKCompactMessage {
  type: 'compact'
  phase: 'start' | 'progress' | 'end'
  text?: string
  summary?: string
}

/** Status update during long operations. */
export interface SDKStatusMessage {
  type: 'system'
  subtype: 'status'
  message: string
}

/** Task lifecycle notification. */
export interface SDKTaskNotificationMessage {
  type: 'system'
  subtype: 'task_notification'
  task_id: string
  status: string
  message?: string
}

/** Rate limit event. */
export interface SDKRateLimitEvent {
  type: 'system'
  subtype: 'rate_limit'
  retry_after_ms?: number
  message: string
}

/**
 * Emitted when the LLM stream is being retried after a transient failure.
 * Carries structured data only — rendering/i18n is the consumer's job.
 */
export interface SDKRetryMessage {
  type: 'system'
  subtype: 'retry'
  /** 1-based retry attempt number. */
  attempt: number
  /** Classification of the error that triggered the retry. */
  error_type: 'connection' | 'rate_limit' | 'overloaded' | 'server' | 'auth' | 'prompt_too_long' | 'unknown'
  /** How long the SDK waits before this retry, in milliseconds. */
  delay_ms: number
}

/** Emitted by MultiTask / Task the instant a subtask's IIFE resolves,
 *  carrying parent-level semantic state (post all post-processing).
 *  Wraps inside an SDKSubagentMessage; outer wrapper provides the
 *  parent_tool_use_id, session_id, task_index, task_description context. */
export interface SDKSubtaskCompletedEvent {
  type: 'subtask_completed'
  /** Parent-level final status — NOT the inner engine's raw subtype. */
  status: 'completed' | 'failed' | 'aborted'
  /** Subtask final output text (warning placeholder when maxTurnsHit with no text). */
  output: string | null
  /** Reason on failure/abort; null on success. */
  error: string | null
  /** Distinct tool names invoked by the subtask. */
  toolsUsed: string[]
  /** Whether the subtask hit the maxTurns limit (status may still be 'completed'). */
  maxTurnsHit: boolean
}

/** Subagent streaming event — wraps a subagent's SDKMessage for the parent stream. */
export interface SDKSubagentMessage {
  type: 'subagent'
  /** The tool_use_id of the parent Task tool call that spawned this subagent */
  parent_tool_use_id: string
  /** The subagent's session ID */
  session_id?: string
  /** Index of the subtask within a MultiTask call */
  task_index?: number
  /** Description of the subtask within a MultiTask call */
  task_description?: string
  /** The subagent event (assistant, partial_message, tool_result, etc.) */
  event:
    | SDKAssistantMessage
    | SDKToolResultMessage
    | SDKPartialMessage
    | SDKSystemMessage
    | SDKSubtaskCompletedEvent
}

// --------------------------------------------------------------------------
// Token Usage
// --------------------------------------------------------------------------

export interface TokenUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  total_input_tokens?: number
}

// --------------------------------------------------------------------------
// Tool Types
// --------------------------------------------------------------------------

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: ToolInputSchema
  call: (input: any, context: ToolContext) => Promise<ToolResult>
  isReadOnly?: () => boolean
  isConcurrencySafe?: () => boolean
  isEnabled?: () => boolean
  prompt?: (context: ToolContext) => Promise<string>

  /**
   * One-line summary (≤120 chars recommended), used in the deferred-tools
   * catalog injected into the system prompt. Should be a plain description
   * of what the tool does — no usage instructions, no parameter docs.
   *
   * If absent, the catalog falls back to `truncateForCatalog(description)`
   * (200 chars + '...(more)' suffix on overflow). See src/tools/helpers.ts.
   *
   * Only required for tools marked `deferred: true`. Eager tools don't
   * appear in the catalog, so this field is unused for them.
   */
  shortDescription?: string

  /**
   * If true, this tool is NOT eagerly loaded into the provider's `tools`
   * array. The model must use FindTool to load its full schema before
   * invoking it. Default: false (eager).
   *
   * NOTE: "deferred" is about schema visibility, NOT access control.
   */
  deferred?: boolean
}

export interface ToolInputSchema {
  type: 'object'
  properties: Record<string, any>
  required?: string[]
}

export interface ToolContext {
  cwd: string
  abortSignal?: AbortSignal
  /** The tool_use_id of the current tool call that spawned this execution */
  toolUseId?: string
  sessionId?: string
  /** Agent identifier for memory isolation */
  agentId: string
  /** Per-agent tool services for state isolation */
  services: ToolServices
  /** Resolved environment for tool subprocesses. Pre-computed by the engine
   *  from AgentOptions.toolEnv + toolEnvInherit. Tools should pass this
   *  directly to spawn() / crossSpawn() as the env option. */
  subprocessEnv: Record<string, string | undefined>
}

/** Context available to the Skill tool: resolved skill set + registry. */
export interface SkillContext extends ToolContext {
  resolvedSkills: import('./skills/types.js').SkillDefinition[]
  skillRegistry: import('./skills/registry.js').SkillRegistry
}

/** Context available to subagent-spawning tools (Task/MultiTask). */
export interface SubagentContext extends ToolContext {
  env: AgentEnvironment
  subAgents: Record<string, AgentDefinition>
  /**
   * Emit an event to the parent agent's streaming output.
   * Used by tools like TaskTool to propagate subagent events.
   */
  emitEvent?: (event: SDKMessage) => void
}

export interface ToolResult {
  type: 'tool_result'
  tool_use_id: string
  content: string | any[]
  is_error?: boolean
  /** Structured data for UI rendering. Not sent to LLM, not persisted to transcript. */
  metadata?: unknown
}

// --------------------------------------------------------------------------
// Permission Types
// --------------------------------------------------------------------------

export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'
  | 'dontAsk'
  | 'auto'

export type PermissionBehavior = 'allow' | 'deny'

export type CanUseToolResult = {
  behavior: PermissionBehavior
  updatedInput?: unknown
  message?: string
}

export type CanUseToolFn = (
  tool: ToolDefinition,
  input: unknown,
) => Promise<CanUseToolResult>

// --------------------------------------------------------------------------
// MCP Types
// --------------------------------------------------------------------------

export type McpServerConfig =
  | McpStdioConfig
  | McpSseConfig
  | McpHttpConfig

/**
 * Accepted `type` / `transport` spellings for the MCP Streamable HTTP transport.
 *
 * The SDK treats all of these as equivalent and instantiates
 * `StreamableHTTPClientTransport` for each:
 *   - `streamable_http` — canonical spelling (matches the MCP spec)
 *   - `streamable-http` — kebab-case alias common in ecosystem config files
 *   - `http`            — backwards-compatible alias (pre-existing SDK spelling)
 *
 * When the selector is omitted entirely (neither `type` nor `transport`), the
 * SDK infers the transport from the other fields: `command` present → stdio,
 * `url` present → Streamable HTTP. See `McpHttpConfig` and `McpStdioConfig`.
 *
 * The selector may be supplied via either `type` or `transport`. The two field
 * names exist because portable MCP config files (e.g. `.agents/mcp.json`) and
 * provider documentation use both spellings; the SDK accepts either. If both
 * are present and normalize to different transport kinds, the SDK fails fast
 * with a conflict error rather than silently choosing one.
 */
export type McpStreamableHttpType = 'http' | 'streamable_http' | 'streamable-http'

export interface McpRetryPolicy {
  /** Maximum number of initialization retries. */
  maxRetries?: number
  /** Initialization timeout in milliseconds. */
  timeoutMs?: number
}

export interface McpStdioConfig {
  type?: 'stdio'
  /** Alternate selector field name for `type`. See `McpStreamableHttpType` doc. */
  transport?: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
  /**
   * Working directory for the spawned MCP server process.
   *
   * - Explicit value wins.
   * - When omitted, the Agent SDK falls back to `AgentOptions.cwd` before
   *   passing the config to the underlying transport. If neither is set, the
   *   MCP SDK default (`process.cwd()`) applies.
   *
   * Relative `command` paths and relative entries in `args` resolve against
   * this directory.
   */
  cwd?: string
  retryPolicy?: McpRetryPolicy
  /**
   * Override the global MCP deferred default for this server's tools.
   * - undefined: use global default (deferred when eagerMcp is false/absent; eager when eagerMcp is true)
   * - true: force this server's tools to be deferred
   * - false: force this server's tools to be eager
   *
   * See AgentOptions.eagerMcp for the global default.
   */
  deferred?: boolean
}

export interface McpSseConfig {
  type?: 'sse'
  /** Alternate selector field name for `type`. See `McpStreamableHttpType` doc. */
  transport?: 'sse'
  url: string
  headers?: Record<string, string>
  retryPolicy?: McpRetryPolicy
  /**
   * Override the global MCP deferred default for this server's tools.
   * - undefined: use global default (deferred when eagerMcp is false/absent; eager when eagerMcp is true)
   * - true: force this server's tools to be deferred
   * - false: force this server's tools to be eager
   *
   * See AgentOptions.eagerMcp for the global default.
   */
  deferred?: boolean
}

export interface McpHttpConfig {
  /**
   * Transport selector. Accepts the standard Streamable HTTP spellings
   * (`streamable_http`, `streamable-http`) plus the backwards-compatible
   * `http` alias. See `McpStreamableHttpType`.
   *
   * When omitted, the SDK infers Streamable HTTP from the presence of `url`
   * (and absence of `command`).
   */
  type?: McpStreamableHttpType
  /** Alternate selector field name for `type`. See `McpStreamableHttpType` doc. */
  transport?: McpStreamableHttpType
  url: string
  headers?: Record<string, string>
  retryPolicy?: McpRetryPolicy
  /**
   * Override the global MCP deferred default for this server's tools.
   * - undefined: use global default (deferred when eagerMcp is false/absent; eager when eagerMcp is true)
   * - true: force this server's tools to be deferred
   * - false: force this server's tools to be eager
   *
   * See AgentOptions.eagerMcp for the global default.
   */
  deferred?: boolean
}

// --------------------------------------------------------------------------
// Agent Types
// --------------------------------------------------------------------------

export type PromptSpec = string | { type: 'preset'; preset: SystemPromptPreset; append?: string }

export interface AgentDefinition {
  description: string
  prompt: PromptSpec
  /** Appended to the resolved system prompt */
  appendPrompt?: string
  /** Tool allow-list (consumed by resolveAgent). */
  allowedTools?: string[]
  disallowedTools?: string[]
  /** Skill allow-list (consumed by resolveAgent). */
  availableSkills?: string[]
  maxTurns?: number
}

/** Session-level shared "world" built once at runtime; all agents share it. */
export interface AgentEnvironment {
  provider: import('./providers/types.js').LLMProvider
  model: string
  maxTokens: number
  cwd: string
  customTools: ToolDefinition[]
  mcpTools: ToolDefinition[]
  settingSources?: SettingSource[]
  skillRegistry: import('./skills/registry.js').SkillRegistry
  /** Per-agent tool services for state isolation */
  toolServices?: ToolServices
  /** Pre-computed subprocess env for Bash/Grep tools. */
  subprocessEnv: Record<string, string | undefined>
}

/** An agent's effective capabilities, resolved exactly once by resolveAgent. */
export interface ResolvedAgent {
  definition: AgentDefinition
  tools: ToolDefinition[]
  deferredTools: ToolDefinition[]
  skills: import('./skills/types.js').SkillDefinition[]
}

export interface ThinkingConfig {
  type: 'adaptive' | 'enabled' | 'disabled'
  budgetTokens?: number
}

// --------------------------------------------------------------------------
// Sandbox Types
// --------------------------------------------------------------------------

export interface SandboxSettings {
  enabled?: boolean
  autoAllowBashIfSandboxed?: boolean
  excludedCommands?: string[]
  allowUnsandboxedCommands?: boolean
  network?: SandboxNetworkConfig
  filesystem?: SandboxFilesystemConfig
  ignoreViolations?: Record<string, string[]>
  enableWeakerNestedSandbox?: boolean
  ripgrep?: { command: string; args?: string[] }
}

export interface SandboxNetworkConfig {
  allowedDomains?: string[]
  allowManagedDomainsOnly?: boolean
  allowLocalBinding?: boolean
  allowUnixSockets?: string[]
  allowAllUnixSockets?: boolean
  httpProxyPort?: number
  socksProxyPort?: number
}

export interface SandboxFilesystemConfig {
  allowWrite?: string[]
  denyWrite?: string[]
  denyRead?: string[]
}

// --------------------------------------------------------------------------
// Output Format
// --------------------------------------------------------------------------

export interface OutputFormat {
  type: 'json_schema'
  schema: Record<string, unknown>
}

// --------------------------------------------------------------------------
// Setting Sources
// --------------------------------------------------------------------------

export type SettingSource = 'user' | 'project'

export type SkillSource = 'programmatic' | 'user' | 'project'

export type SystemPromptPreset = 'default' | 'claude_code'

// --------------------------------------------------------------------------
// Model Info
// --------------------------------------------------------------------------

export interface ModelInfo {
  value: string
  displayName: string
  description: string
  supportsEffort?: boolean
  supportedEffortLevels?: ('low' | 'medium' | 'high' | 'max')[]
  supportsAdaptiveThinking?: boolean
  supportsFastMode?: boolean
}

/**
 * Options for creating an Agent instance.
 *
 * The fields are organized into 7 logical groups (matching the internal config
 * interfaces defined in agent.ts). Each group is marked with a `=== GroupName ===`
 * section comment for discoverability and navigation.
 */
export interface AgentOptions {
  // ===========================================================================
  // === ProviderConfig === (11 fields)
  // LLM provider configuration: model selection, credentials, reasoning, and API tuning.
  // ===========================================================================

  /** LLM model ID. */
  model?: string
  /**
   * API type: 'anthropic-messages' or 'openai-completions'.
   * Falls back to ZERONE_AGENT_API_TYPE env var. Default: 'anthropic-messages'.
   */
  apiType?: import('./providers/types.js').ApiType
  /** API key. Falls back to ZERONE_AGENT_API_KEY env var. */
  apiKey?: string
  /** API base URL override. */
  baseURL?: string
  /** Maximum tokens for responses. */
  maxTokens?: number
  /** Effort level for reasoning. Preset values: 'low' | 'medium' | 'high' | 'xhigh' | 'max'. Custom values passed through as-is. */
  effort?: string
  /** Fallback model if primary is unavailable. */
  fallbackModel?: string
  /** Extended thinking configuration. */
  thinking?: ThinkingConfig
  /** Maximum thinking tokens (deprecated, use thinking.budgetTokens). */
  maxThinkingTokens?: number
  /** Context window size in tokens for the model. Overrides auto-detection from model name. */
  contextWindow?: number
  /** SDK betas to enable. */
  betas?: string[]

  // ===========================================================================
  // === EnvironmentConfig === (9 fields)
  // Execution context: working directory, environment, sandbox, and MCP servers.
  // ===========================================================================

  /** Working directory for file/shell tools. */
  cwd?: string
  /** Environment variables. */
  env?: Record<string, string | undefined>
  /** Environment variables passed to tool subprocesses (Bash, Grep).
   *  Merged with process.env by default; use toolEnvInherit:false to replace entirely. */
  toolEnv?: Record<string, string | undefined>
  /** Whether tool subprocesses inherit process.env (default: true).
   *  - true:  env = { ...process.env, ...(toolEnv ?? {}) }  ← toolEnv overrides
   *  - false: env = toolEnv ?? {}                            ← host fully controls */
  toolEnvInherit?: boolean
  /** Sandbox configuration. */
  sandbox?: SandboxSettings
  /** Additional working directories. */
  additionalDirectories?: string[]
  /** MCP server configurations. */
  mcpServers?: Record<string, McpServerConfig | any> // supports McpSdkServerConfig
  /** Default retry policy for MCP server initialization. Defaults to { maxRetries: 1, timeoutMs: 5000 }. */
  mcpRetryPolicy?: McpRetryPolicy
  /**
   * If true, MCP tools default to eager loading (pre-sub-project-2 behavior).
   * Useful as a global escape hatch when the user doesn't want lazy-loading.
   * Default: false (MCP tools are deferred by default).
   *
   * Per-server `deferred` field on McpServerConfig variants overrides this.
   */
  eagerMcp?: boolean
  /** Strict MCP config validation. */
  strictMcpConfig?: boolean
  /** Maximum request body size in bytes. Defaults to 6MB (6291456). Images are stripped from oldest messages when exceeded. */
  maxRequestBodyBytes?: number
  /** Per-agent tool services for state isolation. Defaults to a fresh DefaultToolServices.
   * Note: a caller-provided ToolServices object shared across Agents intentionally shares
   * its non-cron slots (findTool registry, config) — sharing is caller-controlled; per-Agent
   * isolation of the cron binding is preserved via the copy-on-override combinator. */
  toolServices?: ToolServices
  /**
   * Cron service for the CronCreate/CronDelete/CronList tools (ADR 0005 per-Agent state).
   * When combined with a caller-provided `toolServices`, the Agent builds a per-Agent
   * copy of that object and binds `cron` on the copy — the caller's ToolServices object
   * is never mutated. Null/undefined = cron tools report
   * "Cron service is not initialized."
   */
  cronService?: import('./cron/service.js').CronService

  // ===========================================================================
  // === SessionConfig === (9 fields)
  // Session management: continuation, persistence, checkpointing, and snapshots.
  // ===========================================================================

  /** Continue the most recent session in cwd. */
  continue?: boolean
  /** Resume a specific session by ID. */
  resume?: string
  /** Fork a session instead of continuing it. */
  forkSession?: boolean
  /** Persist session to disk. */
  persistSession?: boolean
  /** Explicit session ID. */
  sessionId?: string
  /** Enable file checkpointing (for rewindFiles). */
  enableFileCheckpointing?: boolean
  /** Snapshot engine for file system tracking. Advanced — most callers should use enableFileRevert instead. */
  snapshotEngine?: import('./snapshot/index.js').SnapshotEngine
  /**
   * Enable file-level revert. When true, SDK auto-creates and manages a
   * SnapshotEngine internally (defaults to true when git is available).
   * Set to false to disable. Ignored if snapshotEngine is explicitly provided.
   */
  enableFileRevert?: boolean
  /** Timeout for snapshot git operations in milliseconds. Defaults to 5000. */
  snapshotTimeoutMs?: number

  // ===========================================================================
  // === PermissionConfig === (5 fields)
  // Access control: tool permission callbacks, modes, and abort controls.
  // ===========================================================================

  /** Permission handler callback. */
  canUseTool?: CanUseToolFn
  /** Permission mode controlling tool approval behavior. */
  permissionMode?: PermissionMode
  /** Permission prompt tool name override. */
  permissionPromptToolName?: string
  /** Abort controller for cancellation. */
  abortController?: AbortController
  /** Abort signal for cancellation. */
  abortSignal?: AbortSignal

  // ===========================================================================
  // === StreamingConfig === (4 fields)
  // Output configuration: streaming, structured output, and format options.
  // ===========================================================================

  /** Whether to include partial streaming events. */
  includePartialMessages?: boolean
  /** Structured output JSON schema. */
  jsonSchema?: Record<string, unknown>
  /** Structured output format. */
  outputFormat?: OutputFormat
  /** Enable prompt suggestions. */
  promptSuggestions?: boolean

  // ===========================================================================
  // === SkillConfig === (5 fields)
  // Skill discovery: setting sources, extra skill directories, and sub-agents.
  // ===========================================================================

  /** Load settings from filesystem. */
  settingSources?: SettingSource[]
  /** Additional user-level skill directories to scan (after default ~/.agents/skills/). */
  extraUserSkillDirs?: string[]
  /** Subagent definitions available to Task/MultiTask. */
  subAgents?: Record<string, AgentDefinition>
  /** Callback emitted when the available skills list changes (e.g. after reloadSkills). */
  onSkillsUpdated?: (event: import('./types.js').SDKSkillsUpdatedMessage) => void

  // ===========================================================================
  // === MiscConfig === (11 fields)
  // Miscellaneous: agent identity, tools, budget, plugins, debug, hooks.
  // ===========================================================================

  /** Agent identifier. Defaults to 'main'. */
  agentId?: string
  /** Main agent definition (prompt, tool/skill allowlists, maxTurns). */
  agent?: AgentDefinition
  /** Caller-provided custom tools, merged with the built-in tool pool. */
  customTools?: ToolDefinition[]
  /** Maximum USD budget per query. */
  maxBudgetUsd?: number
  /** Plugin configurations. */
  plugins?: Array<{ name: string; config?: Record<string, unknown> }>
  /** Debug mode. */
  debug?: boolean
  /** Debug log file. */
  debugFile?: string
  /**
   * Host-provided logger for engine/tool-executor output. Replaces the
   * default console logger; `logLevel` is ignored when this is set.
   */
  logger?: import('./utils/logger.js').Logger
  /**
   * Minimum log level for the default console logger.
   * Default: 'debug' (silent — only `error` prints; tool metadata and
   * redacted input previews are visible only at 'trace').
   * Use 'trace' to include tool-start metadata + redacted input previews.
   */
  logLevel?: import('./utils/logger.js').LogLevel
  /** Tool-specific configuration. */
  toolConfig?: Record<string, unknown>
  /** Extra CLI arguments. */
  extraArgs?: Record<string, string | null>
  /** Hook configurations. */
  hooks?: Record<string, Array<{
    matcher?: string
    hooks: Array<(input: any, toolUseId: string, context: { signal: AbortSignal }) => Promise<any>>
    timeout?: number
  }>>
  /** Maximum number of conversation rounds to include in LLM context.
   *  A "round" = one fresh user input + the complete assistant response
   *  (including any intermediate tool_use/tool_result loops).
   *  Session transcript still persists full history; only the API call
   *  is truncated. Undefined = no limit (current behavior). */
  maxSessionTurns?: number
}

export interface QueryResult {
  /** Final text output from the assistant.
   *  When `is_error` is true this may contain PARTIAL output collected before
   *  the failure (or be empty if the error happened before any text). */
  text: string
  /** Token usage */
  usage: TokenUsage
  /** Number of agentic turns */
  num_turns: number
  /** Duration in milliseconds */
  duration_ms: number
  /** All conversation messages */
  messages: Message[]
  /**
   * True when the engine reported an error result instead of a successful
   * completion (provider failure such as a 429/auth/connection error, hook
   * block, max turns, max budget, ...). Undefined/false on success.
   *
   * Callers MUST check this field — without it a failed prompt() previously
   * looked identical to a successful empty answer. See issue #28.
   */
  is_error?: boolean
  /**
   * Error identity, preserved from the engine result event. The structured
   * classification (e.g. 'rate_limit', 'auth', 'connection') when available;
   * otherwise the error subtype (e.g. 'error_during_execution',
   * 'error_max_turns').
   */
  error_type?: string
  /** Human-readable error messages reported by the engine. */
  errors?: string[]
}

// --------------------------------------------------------------------------
// Query Engine Types
// --------------------------------------------------------------------------

export interface QueryEngineConfig {
  /** Session-level shared "world" (provider, model, cwd, tool pools, skill registry) */
  env: AgentEnvironment
  /** The agent's effective capabilities, resolved once by resolveAgent */
  resolved: ResolvedAgent
  /** Subagent definitions available to Task/MultiTask */
  subAgents?: Record<string, AgentDefinition>
  /** Agent identifier for memory isolation */
  agentId: string
  maxTurns: number
  maxBudgetUsd?: number
  thinking?: ThinkingConfig
  jsonSchema?: Record<string, unknown>
  canUseTool: CanUseToolFn
  includePartialMessages: boolean
  abortSignal?: AbortSignal
  /** Hook registry for lifecycle events */
  hookRegistry?: import('./hooks.js').HookRegistry
  /** Session ID for hook context */
  sessionId?: string
  /** Context window size in tokens for the model. Overrides auto-detection from model name. */
  contextWindow?: number
  /** Maximum request body size in bytes. Images are stripped from oldest messages when exceeded. */
  maxRequestBodyBytes?: number
  /** Maximum conversation rounds to send to LLM. See AgentOptions.maxSessionTurns. */
  maxSessionTurns?: number
  /** Effort level for reasoning. See AgentOptions.effort. */
  effort?: string
  /** Snapshot engine for file system tracking (enables file revert). Optional. */
  snapshotEngine?: import('./snapshot/index.js').SnapshotEngine
  /** Maximum number of retries for streaming LLM calls on disconnect/overload. Default: 5. */
  maxStreamRetries?: number
  /**
   * Host-provided logger. When set, replaces the default console logger
   * (and `logLevel` is ignored — the host logger controls its own level).
   */
  logger?: import('./utils/logger.js').Logger
  /**
   * Minimum log level for the default console logger.
   * Default: 'debug' (silent — only `error` prints). Use 'trace' to
   * include tool-start metadata + redacted input previews.
   */
  logLevel?: import('./utils/logger.js').LogLevel
}

/**
 * Serializable snapshot of engine state for revert support.
 */
export interface EngineSnapshot {
  messages: NormalizedMessageParam[]
  totalUsage: TokenUsage
  totalCost: number
  turnCount: number
  fileSnapshot?: string
}

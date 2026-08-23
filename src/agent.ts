/**
 * Agent - High-level API
 *
 * Provides createAgent() and query() interfaces compatible with
 * @zerone-agent/agent-sdk.
 *
 * Usage:
 *   import { createAgent } from '@zerone-agent/agent-sdk'
 *   const agent = createAgent({ model: 'claude-sonnet-4-6' })
 *   for await (const event of agent.query('Hello')) { ... }
 *
 *   // OpenAI-compatible models
 *   const agent = createAgent({
 *     apiType: 'openai-completions',
 *     model: 'gpt-4o',
 *     apiKey: 'sk-...',
 *     baseURL: 'https://api.openai.com/v1',
 *   })
 */

import type {
  AgentOptions,
  AgentDefinition,
  AgentEnvironment,
  QueryResult,
  SDKMessage,
  SDKCompactMessage,
  ToolDefinition,
  CanUseToolFn,
  Message,
  PermissionMode,
  McpServerConfig,
} from './types.js'
import { QueryEngine } from './engine.js'
import { resolveAgent } from './resolve-agent.js'
import { type MCPConnection } from './mcp/client.js'
import { acquireMCPConnection } from './mcp/pool.js'
import { isSdkServerConfig } from './sdk-mcp-server.js'
import { resolveTransportKind } from './mcp/client.js'
import {
  saveSession,
  loadSession,
} from './session.js'
import { SnapshotEngine } from './snapshot/index.js'
import { isGitAvailable } from './snapshot/git-detector.js'
import { createHookRegistry, type HookRegistry, type HookEvent, type HookInput, type HookOutput } from './hooks.js'
import { loadSkillsFromFilesystem, SkillRegistry, defaultRegistry, registerSkill as registryRegisterSkill, unregisterSkill as registryUnregisterSkill } from './skills/index.js'
import type { SkillDefinition } from './skills/types.js'
import { createProvider, type LLMProvider, type ApiType } from './providers/index.js'
import type { NormalizedMessageParam } from './providers/types.js'
import { DEFAULT_MAX_TOKENS } from './engine.js'
import { compactConversationWithProtectedTail, type AutoCompactState } from './utils/compact.js'
import { resolveSubprocessEnv } from './utils/subprocess-env.js'
import { DefaultToolServices } from './tools/default-services.js'

/** Per-query overrides: AgentOptions plus ad-hoc capability filters layered on the agent definition. */
export type QueryOverrides = Partial<AgentOptions> &
  Partial<Pick<AgentDefinition, 'allowedTools' | 'disallowedTools' | 'availableSkills'>>

// --------------------------------------------------------------------------
// Internal config groups (Task 16: organize 55 AgentOptions fields into 7 groups)
// --------------------------------------------------------------------------

/** LLM provider configuration */
interface ProviderConfig {
  model?: string
  apiType?: ApiType
  apiKey?: string
  baseURL?: string
  maxTokens?: number
  effort?: string
  fallbackModel?: string
  thinking?: import('./types.js').ThinkingConfig
  maxThinkingTokens?: number
  contextWindow?: number
  betas?: string[]
}

/** Environment and execution context */
interface EnvironmentConfig {
  cwd?: string
  env?: Record<string, string | undefined>
  toolEnv?: Record<string, string | undefined>
  toolEnvInherit?: boolean
  sandbox?: import('./types.js').SandboxSettings
  additionalDirectories?: string[]
  mcpServers?: Record<string, import('./types.js').McpServerConfig | any>
  mcpRetryPolicy?: import('./types.js').McpRetryPolicy
  strictMcpConfig?: boolean
  maxRequestBodyBytes?: number
}

/** Session management and persistence */
interface SessionConfig {
  continue?: boolean
  resume?: string
  forkSession?: boolean
  persistSession?: boolean
  sessionId?: string
  enableFileCheckpointing?: boolean
  snapshotEngine?: import('./snapshot/index.js').SnapshotEngine
  enableFileRevert?: boolean
  snapshotTimeoutMs?: number
}

/** Permission and access control */
interface PermissionConfig {
  canUseTool?: import('./types.js').CanUseToolFn
  permissionMode?: import('./types.js').PermissionMode
  permissionPromptToolName?: string
  abortController?: AbortController
  abortSignal?: AbortSignal
}

/** Streaming and output configuration */
interface StreamingConfig {
  includePartialMessages?: boolean
  jsonSchema?: Record<string, unknown>
  outputFormat?: import('./types.js').OutputFormat
  promptSuggestions?: boolean
}

/** Skill discovery and management */
interface SkillConfig {
  settingSources?: import('./types.js').SettingSource[]
  extraUserSkillDirs?: string[]
  subAgents?: Record<string, AgentDefinition>
  onSkillsUpdated?: (event: import('./types.js').SDKSkillsUpdatedMessage) => void
}

/** Miscellaneous configuration */
interface MiscConfig {
  agentId?: string
  agent?: AgentDefinition
  customTools?: ToolDefinition[]
  maxBudgetUsd?: number
  plugins?: Array<{ name: string; config?: Record<string, unknown> }>
  debug?: boolean
  debugFile?: string
  toolConfig?: Record<string, unknown>
  extraArgs?: Record<string, string | null>
  hooks?: Record<string, Array<{
    matcher?: string
    hooks: Array<(input: any, toolUseId: string, context: { signal: AbortSignal }) => Promise<any>>
    timeout?: number
  }>>
  maxSessionTurns?: number
}

// --------------------------------------------------------------------------
// Agent class
// --------------------------------------------------------------------------

export class Agent {
  private cfg: AgentOptions
  private toolPool: ToolDefinition[]
  private modelId: string
  private apiType: ApiType
  private apiCredentials: { key?: string; baseUrl?: string }
  private provider: LLMProvider
  private mcpLinks: MCPConnection[] = []
  private history: NormalizedMessageParam[] = []
  private messageLog: Message[] = []
  private setupDone: Promise<void>
  private sid: string
  private abortCtrl: AbortController | null = null
  private currentEngine: QueryEngine | null = null
  private hookRegistry: HookRegistry
  private lastInputTokens = 0
  private lastOutputTokens = 0

  /** Per-agent skill registry: defaultRegistry (programmatic) as base + own filesystem overlay. */
  readonly skillRegistry = new SkillRegistry(defaultRegistry)

  constructor(options: AgentOptions = {}) {
    // Shallow copy to avoid mutating caller's object
    this.cfg = { ...options }

    // Merge credentials from options.env map, direct options, and process.env
    this.apiCredentials = this.pickCredentials()
    this.modelId = this.cfg.model ?? this.readEnv('ZERONE_AGENT_MODEL') ?? 'claude-sonnet-4-6'
    this.sid = this.cfg.sessionId ?? crypto.randomUUID()

    // Resolve API type
    this.apiType = this.resolveApiType()

    // Create LLM provider
    this.provider = createProvider(this.apiType, {
      apiKey: this.apiCredentials.key,
      baseURL: this.apiCredentials.baseUrl,
    })

    // Build hook registry from options
    this.hookRegistry = createHookRegistry()
    if (this.cfg.hooks) {
      // Convert AgentOptions hooks format to HookConfig
      for (const [event, defs] of Object.entries(this.cfg.hooks)) {
        for (const def of defs) {
          for (const handler of def.hooks) {
            this.hookRegistry.register(event as any, {
              matcher: def.matcher,
              timeout: def.timeout,
              handler: async (input) => {
                const result = await handler(input, input.toolUseId || '', {
                  signal: this.abortCtrl?.signal || new AbortController().signal,
                })
                return result || undefined
              },
            })
          }
        }
      }
    }

    // Tool pool starts empty; setup() collects MCP tools into it.
    // Base + custom tools are assembled per-query by resolveAgent (via env).
    this.toolPool = []

    // Kick off async setup (MCP connections, agent registration, session resume)
    this.setupDone = this.setup()
  }

  /**
   * Resolve API type from options, env, or model name heuristic.
   */
  private resolveApiType(): ApiType {
    // Explicit option
    if (this.cfg.apiType) return this.cfg.apiType

    // Env var
    const envType =
      this.cfg.env?.ZERONE_AGENT_API_TYPE ??
      this.readEnv('ZERONE_AGENT_API_TYPE')
    if (envType === 'openai-completions' || envType === 'anthropic-messages') {
      return envType
    }

    // Heuristic from model name
    const model = this.modelId.toLowerCase()
    if (
      model.includes('gpt-') ||
      model.includes('o1') ||
      model.includes('o3') ||
      model.includes('o4') ||
      model.includes('deepseek') ||
      model.includes('qwen') ||
      model.includes('yi-') ||
      model.includes('glm') ||
      model.includes('mistral') ||
      model.includes('gemma')
    ) {
      return 'openai-completions'
    }

    return 'anthropic-messages'
  }

  /** Pick API key and base URL from options or ZERONE_AGENT_* env vars. */
  private pickCredentials(): { key?: string; baseUrl?: string } {
    const envMap = this.cfg.env
    return {
      key:
        this.cfg.apiKey ??
        envMap?.ZERONE_AGENT_API_KEY ??
        envMap?.ZERONE_AGENT_AUTH_TOKEN ??
        this.readEnv('ZERONE_AGENT_API_KEY') ??
        this.readEnv('ZERONE_AGENT_AUTH_TOKEN'),
      baseUrl:
        this.cfg.baseURL ??
        envMap?.ZERONE_AGENT_BASE_URL ??
        this.readEnv('ZERONE_AGENT_BASE_URL'),
    }
  }

  /** Read a value from process.env (returns undefined if missing). */
  private readEnv(key: string): string | undefined {
    return process.env[key] || undefined
  }

  /** Extract provider configuration from options */
  private extractProviderConfig(opts: AgentOptions): ProviderConfig {
    return {
      model: opts.model,
      apiType: opts.apiType,
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
      maxTokens: opts.maxTokens,
      effort: opts.effort,
      fallbackModel: opts.fallbackModel,
      thinking: opts.thinking,
      maxThinkingTokens: opts.maxThinkingTokens,
      contextWindow: opts.contextWindow,
      betas: opts.betas,
    }
  }

  /** Extract environment configuration from options */
  private extractEnvironmentConfig(opts: AgentOptions): EnvironmentConfig {
    return {
      cwd: opts.cwd,
      env: opts.env,
      toolEnv: opts.toolEnv,
      toolEnvInherit: opts.toolEnvInherit,
      sandbox: opts.sandbox,
      additionalDirectories: opts.additionalDirectories,
      mcpServers: opts.mcpServers,
      mcpRetryPolicy: opts.mcpRetryPolicy,
      strictMcpConfig: opts.strictMcpConfig,
      maxRequestBodyBytes: opts.maxRequestBodyBytes,
    }
  }

  /** Extract session configuration from options */
  private extractSessionConfig(opts: AgentOptions): SessionConfig {
    return {
      continue: opts.continue,
      resume: opts.resume,
      forkSession: opts.forkSession,
      persistSession: opts.persistSession,
      sessionId: opts.sessionId,
      enableFileCheckpointing: opts.enableFileCheckpointing,
      snapshotEngine: opts.snapshotEngine,
      enableFileRevert: opts.enableFileRevert,
      snapshotTimeoutMs: opts.snapshotTimeoutMs,
    }
  }

  /** Extract permission configuration from options */
  private extractPermissionConfig(opts: AgentOptions): PermissionConfig {
    return {
      canUseTool: opts.canUseTool,
      permissionMode: opts.permissionMode,
      permissionPromptToolName: opts.permissionPromptToolName,
      abortController: opts.abortController,
      abortSignal: opts.abortSignal,
    }
  }

  /** Extract streaming configuration from options */
  private extractStreamingConfig(opts: AgentOptions): StreamingConfig {
    return {
      includePartialMessages: opts.includePartialMessages,
      jsonSchema: opts.jsonSchema,
      outputFormat: opts.outputFormat,
      promptSuggestions: opts.promptSuggestions,
    }
  }

  /** Extract skill configuration from options */
  private extractSkillConfig(opts: AgentOptions): SkillConfig {
    return {
      settingSources: opts.settingSources,
      extraUserSkillDirs: opts.extraUserSkillDirs,
      subAgents: opts.subAgents,
      onSkillsUpdated: opts.onSkillsUpdated,
    }
  }

  /** Extract miscellaneous configuration from options */
  private extractMiscConfig(opts: AgentOptions): MiscConfig {
    return {
      agentId: opts.agentId,
      agent: opts.agent,
      customTools: opts.customTools,
      maxBudgetUsd: opts.maxBudgetUsd,
      plugins: opts.plugins,
      debug: opts.debug,
      debugFile: opts.debugFile,
      toolConfig: opts.toolConfig,
      extraArgs: opts.extraArgs,
      hooks: opts.hooks,
      maxSessionTurns: opts.maxSessionTurns,
    }
  }

  /** Build the session-level environment consumed by resolveAgent and the engine. */
  private buildEnv(opts: AgentOptions, provider: LLMProvider): AgentEnvironment {
    // Extract fields into logical groups (Task 16+17)
    const providerConfig = this.extractProviderConfig(opts)
    const envConfig = this.extractEnvironmentConfig(opts)
    const sessionConfig = this.extractSessionConfig(opts)
    const permissionConfig = this.extractPermissionConfig(opts)
    const streamingConfig = this.extractStreamingConfig(opts)
    const skillConfig = this.extractSkillConfig(opts)
    const miscConfig = this.extractMiscConfig(opts)

    // Construct AgentEnvironment from the most relevant groups
    return {
      provider,
      model: providerConfig.model || this.modelId,
      maxTokens: providerConfig.maxTokens ?? DEFAULT_MAX_TOKENS,
      cwd: envConfig.cwd || process.cwd(),
      customTools: miscConfig.customTools ?? [],
      mcpTools: this.toolPool,
      settingSources: skillConfig.settingSources,
      skillRegistry: this.skillRegistry,
      toolServices: opts.toolServices ?? new DefaultToolServices(),
      subprocessEnv: resolveSubprocessEnv({
        toolEnv: envConfig.toolEnv,
        toolEnvInherit: envConfig.toolEnvInherit,
      }),
    }
  }

  /** The root (main) agent definition; a permissive default when none is configured. */
  private rootDefinition(opts: AgentOptions): AgentDefinition {
    return opts.agent ?? { description: 'Main agent', prompt: '' }
  }

  /**
   * Async initialization: connect MCP servers, register agents, resume sessions.
   */
  private async setup(): Promise<void> {
    // Connect MCP servers (supports stdio, SSE, HTTP, and in-process SDK servers)
    if (this.cfg.mcpServers) {
      // Global deferred default: true (deferred) when eagerMcp is unset/false;
      // false (eager) when eagerMcp is true. Per-server `deferred` overrides.
      const globalDefault = !this.cfg.eagerMcp

      for (const [name, config] of Object.entries(this.cfg.mcpServers)) {
        try {
          if (isSdkServerConfig(config)) {
            // In-process SDK MCP server. Compute per-server default and apply
            // OR-relation per tool: tool.deferred ?? serverDefault.
            const serverDefault = config.deferred ?? globalDefault
            const toolsWithDeferred = config.tools.map((t) => ({
              ...t,
              deferred: t.deferred ?? serverDefault,
            }))
            this.toolPool = [...this.toolPool, ...toolsWithDeferred]
          } else {
            // External MCP server. Resolve undefined to global default before
            // passing to acquireMCPConnection — that resolved boolean flows
            // through to createMCPToolDefinition via pool.ts.
            const resolvedConfig: McpServerConfig = {
              ...config,
              deferred: config.deferred ?? globalDefault,
              retryPolicy: {
                maxRetries: config.retryPolicy?.maxRetries ?? this.cfg.mcpRetryPolicy?.maxRetries ?? 1,
                timeoutMs: config.retryPolicy?.timeoutMs ?? this.cfg.mcpRetryPolicy?.timeoutMs ?? 5000,
              },
              // For stdio servers, default `cwd` to the Agent workspace so
              // relative executables and relative args resolve against the
              // agent's cwd rather than the host process's. Explicit server
              // `cwd` always wins; non-stdio transports are not affected.
              // See issue #14 (stdio working-directory base).
              ...(resolveTransportKind(config) === 'stdio' && config.cwd === undefined && this.cfg.cwd
                ? { cwd: this.cfg.cwd }
                : {}),
            }
            const connection = await acquireMCPConnection(name, resolvedConfig, {
              timeoutMs: resolvedConfig.retryPolicy?.timeoutMs,
              signal: this.cfg.abortSignal,
            })
            this.mcpLinks.push(connection)

            if (connection.status === 'connected' && connection.tools.length > 0) {
              this.toolPool = [...this.toolPool, ...connection.tools]
            } else if (connection.error) {
              console.warn(`[MCP] Skipped "${name}": ${connection.error instanceof Error ? connection.error.message : connection.error}`)
            }
          }
        } catch (err: any) {
          console.error(`[MCP] Failed to connect to "${name}": ${err.message}`)
        }
      }
    }

    // Resume or continue session
    if (this.cfg.resume) {
      const sessionData = await loadSession(this.cfg.resume)
      if (sessionData) {
        this.history = sessionData.messages
        this.sid = this.cfg.resume
        if (sessionData.metadata.lastInputTokens) {
          this.lastInputTokens = sessionData.metadata.lastInputTokens
        }
        if (sessionData.metadata.lastOutputTokens) {
          this.lastOutputTokens = sessionData.metadata.lastOutputTokens
        }
      }
    }

    // Auto-create SnapshotEngine if file revert is enabled (default: auto-detect git)
    if (!this.cfg.snapshotEngine && this.cfg.enableFileRevert !== false) {
      const hasGit = await isGitAvailable()
      if (hasGit) {
        const worktree = this.cfg.cwd || process.cwd()
        this.cfg.snapshotEngine = new SnapshotEngine({
          worktree,
          timeoutMs: this.cfg.snapshotTimeoutMs,
          signal: this.cfg.abortSignal,
        })
        await this.cfg.snapshotEngine.init()
      }
    }

    // Load filesystem skills if settingSources is configured
    if (this.cfg.settingSources && this.cfg.settingSources.length > 0) {
      try {
        const cwd = this.cfg.cwd ?? process.cwd()
        await loadSkillsFromFilesystem(cwd, this.cfg.settingSources, {
          extraUserSkillDirs: this.cfg.extraUserSkillDirs,
        }, this.skillRegistry)
      } catch (error) {
        // Don't fail agent startup
        console.error('Failed to load filesystem skills:', error)
      }
    }
  }

  /**
   * Run a query with streaming events.
   */
  async *query(
    prompt: string,
    overrides?: QueryOverrides,
  ): AsyncGenerator<SDKMessage, void> {
    await this.setupDone

    const opts = { ...this.cfg, ...overrides }

    // Create abort controller for this query
    this.abortCtrl = opts.abortController || new AbortController()
    if (opts.abortSignal) {
      opts.abortSignal.addEventListener('abort', () => this.abortCtrl?.abort(), { once: true })
    }

    // Build canUseTool based on permission mode
    const permMode = opts.permissionMode ?? 'bypassPermissions'
    const canUseTool: CanUseToolFn = opts.canUseTool ?? (async (_tool, _input) => {
      if (permMode === 'bypassPermissions' || permMode === 'dontAsk' || permMode === 'auto') {
        return { behavior: 'allow' }
      }
      if (permMode === 'acceptEdits') {
        return { behavior: 'allow' }
      }
      return { behavior: 'allow' }
    })

    // Recreate provider if overrides change credentials or apiType
    let provider = this.provider
    if (overrides?.apiType || overrides?.apiKey || overrides?.baseURL) {
      const resolvedApiType = overrides.apiType ?? this.apiType
      provider = createProvider(resolvedApiType, {
        apiKey: overrides.apiKey ?? this.apiCredentials.key,
        baseURL: overrides.baseURL ?? this.apiCredentials.baseUrl,
      })
    }

    // Resolve the root agent's effective capabilities exactly once per query
    const definition = this.rootDefinition(opts)
    const mergedDefinition: AgentDefinition = {
      ...definition,
      allowedTools: overrides?.allowedTools ?? definition.allowedTools,
      disallowedTools: overrides?.disallowedTools ?? definition.disallowedTools,
      availableSkills: overrides?.availableSkills ?? definition.availableSkills,
    }
    const env = this.buildEnv(opts, provider)
    const resolved = resolveAgent(env, mergedDefinition)

    // Sync from previous engine — external modifications (e.g. revert)
    // may have changed engine.messages without updating this.history
    if (this.currentEngine) {
      this.history = this.currentEngine.getMessages()
    }

    // Create query engine with current conversation state
    const engine = new QueryEngine({
      env,
      resolved,
      subAgents: opts.subAgents,
      agentId: opts.agentId ?? 'main',
      maxTurns: mergedDefinition.maxTurns ?? 10,
      maxBudgetUsd: opts.maxBudgetUsd,
      thinking: opts.thinking,
      jsonSchema: opts.jsonSchema,
      canUseTool,
      includePartialMessages: opts.includePartialMessages ?? false,
      abortSignal: this.abortCtrl.signal,
      hookRegistry: this.hookRegistry,
      sessionId: this.sid,
      contextWindow: opts.contextWindow,
      maxRequestBodyBytes: opts.maxRequestBodyBytes,
      maxSessionTurns: opts.maxSessionTurns,
      effort: opts.effort,
      snapshotEngine: opts.snapshotEngine ?? this.cfg.snapshotEngine,
      logger: opts.logger ?? this.cfg.logger,
      logLevel: opts.logLevel ?? this.cfg.logLevel,
    }, { lastInputTokens: this.lastInputTokens, lastOutputTokens: this.lastOutputTokens })
    this.currentEngine = engine

    // Inject existing conversation history
    for (const msg of this.history) {
      (engine as any).messages.push(msg)
    }

    // Run the engine (try/finally ensures persistence even on abort)
    try {
      // Push user prompt FIRST so the log is chronologically correct.
      // (Previously pushed in finally after assistant events, causing user
      // messages to appear after their own assistant responses.)
      this.messageLog.push({
        type: 'user',
        message: { role: 'user', content: prompt },
        uuid: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
      })

      for await (const event of engine.submitMessage(prompt)) {
        if (event.type === 'assistant') {
          const timestamp = new Date().toISOString()
          ;(event as any).session_id = this.sid
          ;(event as any).timestamp = timestamp
          this.messageLog.push({
            type: 'assistant',
            message: event.message,
            uuid: event.uuid,
            timestamp,
          })
        }

        yield event
      }
    } finally {
      this.history = engine.getMessages()
      const engineState = engine.getState()
      this.lastInputTokens = engineState.lastInputTokens
      this.lastOutputTokens = engineState.lastOutputTokens

      // (User message push removed from here — moved above the stream loop.)

      if (this.cfg.persistSession !== false && this.history.length > 0) {
        try {
          await saveSession(this.sid, this.history, {
            cwd: this.cfg.cwd || process.cwd(),
            model: this.modelId,
            provider: this.apiType,
            summary: undefined,
            lastInputTokens: this.lastInputTokens,
            lastOutputTokens: this.lastOutputTokens,
          })
        } catch {
          // best-effort
        }
      }
    }
  }

  /**
   * Convenience method: send a prompt and collect the final answer as a single object.
   * Internally iterates through the streaming query and aggregates the outcome.
   */
  async prompt(
    text: string,
    overrides?: QueryOverrides,
  ): Promise<QueryResult> {
    const t0 = performance.now()
    const collected = {
      text: '',
      turns: 0,
      tokens: { in: 0, out: 0 },
      is_error: false,
      error_type: undefined as string | undefined,
      errors: undefined as string[] | undefined,
    }

    for await (const ev of this.query(text, overrides)) {
      switch (ev.type) {
        case 'assistant': {
          // Extract the last assistant text (multi-turn: only final answer matters)
          const fragments = (ev.message.content as any[])
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
          if (fragments.length) collected.text = fragments.join('')
          break
        }
        case 'result': {
          collected.turns = ev.num_turns ?? 0
          collected.tokens.in = ev.usage?.input_tokens ?? 0
          collected.tokens.out = ev.usage?.output_tokens ?? 0
          // Issue #28: never present an engine error result as a successful
          // QueryResult. The engine signals failure via is_error:true (hook
          // block) and/or an 'error*' subtype (stream error, max turns/budget).
          const subtype = typeof ev.subtype === 'string' ? ev.subtype : ''
          if (ev.is_error === true || subtype.startsWith('error')) {
            collected.is_error = true
            // Prefer the structured classification (e.g. 'rate_limit'); fall
            // back to the subtype (e.g. 'error_during_execution').
            collected.error_type = ev.error_type ?? subtype
            collected.errors = ev.errors
          }
          break
        }
      }
    }

    return {
      text: collected.text,
      usage: { input_tokens: collected.tokens.in, output_tokens: collected.tokens.out },
      num_turns: collected.turns,
      duration_ms: Math.round(performance.now() - t0),
      messages: [...this.messageLog],
      // Only attach error fields when an error occurred — keeps the success
      // shape identical to before this fix.
      ...(collected.is_error
        ? {
            is_error: true,
            error_type: collected.error_type,
            errors: collected.errors ?? [],
          }
        : {}),
    }
  }

  /**
   * Append-only audit log of every user prompt + assistant response emitted to
   * this agent, in chronological order. Never affected by compaction.
   *
   * Contrast with {@link getMessageHistory}, which returns what the engine
   * actually sees on the next turn (post-compaction when triggered).
   */
  getMessageLog(): Message[] {
    return [...this.messageLog]
  }

  /**
   * Reset conversation history.
   */
  clear(): void {
    this.history = []
    this.messageLog = []
  }

  /**
   * Interrupt the current query.
   */
  async interrupt(): Promise<void> {
    this.abortCtrl?.abort()
  }

  // --------------------------------------------------------------------------
  // History (for revert/fork targeting)
  // --------------------------------------------------------------------------

  /**
   * Engine's persistent conversation history — what the LLM actually sees on
   * the next turn. Post-compaction (when maxSessionTurns triggers halved
   * compaction), this is `[summary_pair, ...recent_turns]`.
   *
   * Use this for revert/fork targeting, session persistence, or any logic
   * that needs to mirror the engine's view of the conversation.
   *
   * Contrast with {@link getMessageLog}, which returns the append-only audit
   * log of every emitted user/assistant message (never compacted).
   */
  async getMessageHistory(): Promise<NormalizedMessageParam[]> {
    await this.setupDone
    return [...this.history]
  }

  /**
   * Persist current history to session file.
   */
  private async persistSession(): Promise<void> {
    if (this.cfg.persistSession === false || this.history.length === 0) return
    try {
      await saveSession(this.sid, this.history, {
        cwd: this.cfg.cwd || process.cwd(),
        model: this.modelId,
        provider: this.apiType,
        lastInputTokens: this.lastInputTokens,
        lastOutputTokens: this.lastOutputTokens,
      })
    } catch {
      // best-effort
    }
  }

  /**
   * Fire lifecycle hooks. Returns hook outputs; never throws.
   */
  private async executeHooks(
    event: HookEvent,
    extra?: Partial<HookInput>,
  ): Promise<HookOutput[]> {
    if (!this.hookRegistry.hasHooks(event)) return []
    try {
      return await this.hookRegistry.execute(event, {
        event,
        sessionId: this.sid,
        cwd: this.cfg.cwd || process.cwd(),
        ...extra,
      })
    } catch {
      return []
    }
  }

  /**
   * Manually trigger compaction of the current conversation history.
   *
   * Summarizes older history while protecting the most recent turns, firing
   * PreCompact/PostCompact hooks. Streams `compact` events (start/progress/end)
   * so callers can surface progress (e.g. a `/compact` command). Uses the same
   * algorithm as auto-compaction. Persists the session afterwards.
   */
  async *compactStream(): AsyncGenerator<SDKCompactMessage> {
    await this.setupDone
    await this.executeHooks('PreCompact')
    try {
      const state: AutoCompactState = {
        compacted: false,
        turnCounter: 0,
        consecutiveFailures: 0,
        lastInputTokens: this.lastInputTokens,
        lastOutputTokens: this.lastOutputTokens,
      }
      const gen = compactConversationWithProtectedTail(
        this.provider,
        this.modelId,
        this.history,
        state,
      )
      while (true) {
        const next = await gen.next()
        if (next.done) {
          this.history = next.value.messages
          this.lastInputTokens = next.value.state.lastInputTokens
          this.lastOutputTokens = next.value.state.lastOutputTokens
          break
        }
        yield next.value
      }
      await this.executeHooks('PostCompact')
    } catch {
      // Leave history unchanged on failure; skip PostCompact
    }

    if (this.cfg.persistSession !== false && this.history.length > 0) {
      try {
        await saveSession(this.sid, this.history, {
          cwd: this.cfg.cwd || process.cwd(),
          model: this.modelId,
          provider: this.apiType,
          summary: undefined,
          lastInputTokens: this.lastInputTokens,
          lastOutputTokens: this.lastOutputTokens,
        })
      } catch {
        // best-effort
      }
    }
  }

  /**
   * Manually trigger compaction (non-streaming convenience wrapper).
   *
   * Consumes `compactStream()` and returns the resulting summary. Useful when a
   * caller does not need incremental progress events.
   */
  async compact(): Promise<{ summary: string; compacted: boolean }> {
    let summary = ''
    for await (const ev of this.compactStream()) {
      if (ev.type === 'compact' && ev.phase === 'end') {
        summary = ev.summary ?? ''
      }
    }
    return { summary, compacted: summary.length > 0 }
  }

  /**
   * Change the model during a session.
   */
  async setModel(model?: string): Promise<void> {
    if (model) {
      this.modelId = model
      this.cfg.model = model
    }
  }

  /**
   * Change the permission mode during a session.
   */
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.cfg.permissionMode = mode
  }

  /**
   * Set maximum thinking tokens.
   */
  async setMaxThinkingTokens(maxThinkingTokens: number | null): Promise<void> {
    if (maxThinkingTokens === null) {
      this.cfg.thinking = { type: 'disabled' }
    } else {
      this.cfg.thinking = { type: 'enabled', budgetTokens: maxThinkingTokens }
    }
  }

  /**
   * Get the session ID.
   */
  getSessionId(): string {
    return this.sid
  }

  /**
   * Get the current API type.
   */
  getApiType(): ApiType {
    return this.apiType
  }

  /**
   * Reload all skills from filesystem and bundled definitions.
   * Returns the updated skills list and any changes.
   *
   * NOTE: Not safe against concurrent access — the filesystem overlay is
   * cleared before re-registering. Do not call while the agent is actively
   * processing, as concurrent reads may see an empty registry.
   */
  async reloadSkills(): Promise<{ skills: string[]; added?: string[]; removed?: string[] }> {
    const before = this.skillRegistry.getUserInvocable().map(s => s.name).sort()

    // Clear filesystem-loaded skills (programmatic skills in defaultRegistry are untouched)
    this.skillRegistry.clearFilesystem()

    // Reload filesystem skills if settingSources is configured
    if (this.cfg.settingSources && this.cfg.settingSources.length > 0) {
      try {
        const cwd = this.cfg.cwd ?? process.cwd()
        await loadSkillsFromFilesystem(cwd, this.cfg.settingSources, {
          extraUserSkillDirs: this.cfg.extraUserSkillDirs,
        }, this.skillRegistry)
      } catch (error) {
        console.error('Failed to reload filesystem skills:', error)
      }
    }

    const after = this.skillRegistry.getUserInvocable().map(s => s.name).sort()
    const beforeSet = new Set(before)
    const afterSet = new Set(after)
    const added = after.filter(s => !beforeSet.has(s))
    const removed = before.filter(s => !afterSet.has(s))

    const result = {
      skills: after,
      ...(added.length > 0 ? { added } : {}),
      ...(removed.length > 0 ? { removed } : {}),
    }

    if (this.cfg.onSkillsUpdated) {
      this.cfg.onSkillsUpdated({
        type: 'system',
        subtype: 'skills_updated',
        ...result,
      })
    }

    return result
  }

  /**
   * Register a single skill programmatically.
   */
  registerSkill(definition: SkillDefinition): void {
    // Deliberately writes to the GLOBAL defaultRegistry — programmatic
    // skills are globally shared by design (visible to all agents).
    registryRegisterSkill(definition)
  }

  /**
   * Unregister a single skill by name.
   * Returns true if the skill was found and removed.
   */
  unregisterSkill(name: string): boolean {
    // Delegates to the GLOBAL defaultRegistry (see registerSkill above).
    return registryUnregisterSkill(name)
  }

  /**
   * Get the list of available skills (whitelist).
   */
  getAvailableSkills(): string[] | undefined {
    return this.cfg.agent?.availableSkills
  }

  /**
   * Set the available skills whitelist.
   */
  setAvailableSkills(availableSkills: string[] | undefined): void {
    if (this.cfg.agent) {
      this.cfg.agent.availableSkills = availableSkills
    } else if (availableSkills !== undefined) {
      this.cfg.agent = { description: 'Main agent', prompt: '', availableSkills }
    }
  }

  /**
   * Close MCP connections and clean up.
   * Optionally persist session to disk.
   */
  async close(): Promise<void> {
    // Persist session if enabled
    if (this.cfg.persistSession !== false && this.history.length > 0) {
      try {
        await saveSession(this.sid, this.history, {
          cwd: this.cfg.cwd || process.cwd(),
          model: this.modelId,
          provider: this.apiType,
          summary: undefined,
          lastInputTokens: this.lastInputTokens,
          lastOutputTokens: this.lastOutputTokens,
        })
      } catch {
        // Session persistence is best-effort
      }
    }

    for (const conn of this.mcpLinks) {
      await conn.close()
    }
    this.mcpLinks = []

    // Run gc once on close to clean up unreachable snapshot objects.
    // This is best-effort and non-blocking for shutdown.
    try {
      await this.cfg.snapshotEngine?.gc()
    } catch {
      // ignore
    }
  }
}

// --------------------------------------------------------------------------
// Factory function
// --------------------------------------------------------------------------

/** Factory: shorthand for `new Agent(options)`. */
export function createAgent(options: AgentOptions = {}): Agent {
  return new Agent(options)
}

// --------------------------------------------------------------------------
// Standalone query — one-shot convenience wrapper
// --------------------------------------------------------------------------

/**
 * Execute a single agentic query without managing an Agent instance.
 * The agent is created, used, and cleaned up automatically.
 */
export async function* query(params: {
  prompt: string
  options?: AgentOptions
}): AsyncGenerator<SDKMessage, void> {
  const ephemeral = createAgent(params.options)
  try {
    yield* ephemeral.query(params.prompt)
  } finally {
    await ephemeral.close()
  }
}

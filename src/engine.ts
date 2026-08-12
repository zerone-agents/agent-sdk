/**
 * QueryEngine - Core agentic loop
 *
 * Manages the full conversation lifecycle:
 * 1. Take user prompt
 * 2. Build system prompt with context (git status, project context, tools)
 * 3. Call LLM API with tools (via provider abstraction)
 * 4. Stream response
 * 5. Execute tool calls (concurrent for read-only, serial for mutations)
 * 6. Send results back, repeat until done
 * 7. Auto-compact when context exceeds threshold
 * 8. Retry with exponential backoff on transient errors
 */

export const DEFAULT_MAX_TOKENS = 64 * 1024
export const MAX_TOKENS_NON_STREAMING = 16 * 1024

import type {
  SDKMessage,
  SDKCompactMessage,
  SDKRetryMessage,
  QueryEngineConfig,
  ToolDefinition,
  TokenUsage,
  EngineSnapshot,
} from './types.js'
import type {
  LLMProvider,
  CreateMessageResponse,
  NormalizedMessageParam,
  NormalizedTool,
} from './providers/types.js'
import {
  estimateCost,
  DEFAULT_MAX_REQUEST_BODY_BYTES,
} from './utils/tokens.js'
import { enforceBodySizeLimit } from './utils/body-size.js'
import { countSessionTurns, truncateToLastNTurns } from './utils/session-turns.js'
import {
  shouldAutoCompact,
  compactConversation,
  compactConversationWithProtectedTail,
  microCompactMessages,
  pruneMessages,
  createAutoCompactState,
  type AutoCompactState,
} from './utils/compact.js'
import {
  withRetry,
  isPromptTooLongError,
  withStreamRetry,
  classifyError as classifyStreamError,
  getStreamRetryDelay,
  DEFAULT_MAX_STREAM_RETRIES,
} from './utils/retry.js'
import type { RetryEvent } from './utils/retry.js'
import { normalizeMessagesForAPI } from './utils/messages.js'
import type { HookRegistry, HookInput, HookOutput } from './hooks.js'
import { buildSystemPrompt } from './engine/prompt-builder.js'
import { buildResponseFromChunks } from './engine/stream-parser.js'
import type { ToolUseBlock } from './engine/tool-executor.js'
import { executeTools as executeToolsFn } from './engine/tool-executor.js'
import { getTodos, formatTodosReminder, clearTodos, hasActiveTodos } from './tools/todowrite.js'
import { createLogger, type Logger } from './utils/logger.js'
import { formatDurationMs, formatInputPreview, createTimer } from './utils/helpers.js'


// ============================================================================
// Tool format conversion
// ============================================================================

/** Convert a ToolDefinition to the normalized provider tool format. */
function toProviderTool(tool: ToolDefinition): NormalizedTool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }
}

// ============================================================================
// QueryEngine
// ============================================================================

export class QueryEngine {
  private config: QueryEngineConfig
  private provider: LLMProvider
  public messages: NormalizedMessageParam[] = []
  private totalUsage: TokenUsage = { input_tokens: 0, output_tokens: 0 }
  private totalCost = 0
  private turnCount = 0
  private compactState: AutoCompactState
  private sessionId: string
  private apiTimeMs = 0
  private hookRegistry?: HookRegistry
  private snapshotEngine?: import('./snapshot/index.js').SnapshotEngine
  private _compactBoundaryId?: string
  private logger: Logger

  constructor(config: QueryEngineConfig, initialUsage?: { lastInputTokens?: number; lastOutputTokens?: number }) {
    this.config = config
    this.provider = config.env.provider
    this.compactState = createAutoCompactState()
    if (initialUsage?.lastInputTokens) {
      this.compactState.lastInputTokens = initialUsage.lastInputTokens
    }
    if (initialUsage?.lastOutputTokens) {
      this.compactState.lastOutputTokens = initialUsage.lastOutputTokens
    }
    this.sessionId = config.sessionId || crypto.randomUUID()
    this.hookRegistry = config.hookRegistry
    this.snapshotEngine = config.snapshotEngine
    this.logger = config.logger ?? createLogger('engine', { level: config.logLevel })
  }

  /**
   * Execute hooks for a lifecycle event.
   * Returns hook outputs; never throws.
   */
  private async executeHooks(
    event: import('./hooks.js').HookEvent,
    extra?: Partial<HookInput>,
  ): Promise<HookOutput[]> {
    if (!this.hookRegistry?.hasHooks(event)) return []
    try {
      return await this.hookRegistry.execute(event, {
        event,
        sessionId: this.sessionId,
        cwd: this.config.env.cwd,
        ...extra,
      })
    } catch {
      return []
    }
  }

  /**
   * Submit a user message and run the agentic loop.
   * Yields SDKMessage events as the agent works.
   */
  async *submitMessage(
    prompt: string | any[],
  ): AsyncGenerator<SDKMessage> {
    // Hook: SessionStart
    await this.executeHooks('SessionStart')

    // Hook: UserPromptSubmit
    const userHookResults = await this.executeHooks('UserPromptSubmit', {
      toolInput: prompt,
    })
    // Check if any hook blocks the submission
    if (userHookResults.some((r) => r.block)) {
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        usage: { ...this.totalUsage },
        num_turns: 0,
        cost: 0,
        errors: ['Blocked by UserPromptSubmit hook'],
      }
      return
    }

    // Add user message
    const userMessageId = crypto.randomUUID()
    this.messages.push({ role: 'user', content: prompt as any, id: userMessageId })

    // Emit the user message id so callers (e.g. host applications) can target it for revert.
    yield { type: 'user', uuid: userMessageId } as SDKMessage

    // Snapshot workspace before processing — attach to user message for revert support
    if (this.snapshotEngine) {
      try {
        const beforeHash = await this.snapshotEngine.track()
        const userMsg = this.messages[this.messages.length - 1]
        if (userMsg.role === 'user') {
          userMsg._snapshot = { beforeHash }
        }
      } catch {
        // non-fatal — snapshot tracking is best-effort
      }
    }

    // Build system prompt
    const systemPrompt = await buildSystemPrompt(this.config)

    // Seed the ToolSearch registry's deferredTools (resolved may change between
    // queries via overrides) but PRESERVE activatedTools across queries —
    // activations are session-scoped (per Agent instance's ToolServices),
    // not query-scoped. This avoids re-ToolSearch-ing the same tools when the
    // user asks follow-up questions in the same session.
    if (this.config.env.toolServices?.toolSearch) {
      this.config.env.toolServices.toolSearch.deferredTools = this.config.resolved.deferredTools
      // Note: deliberately NOT resetting activatedTools here.
    }

    // Emit init system message
    yield {
      type: 'system',
      subtype: 'init',
      session_id: this.sessionId,
      tools: this.config.resolved.tools.map(t => t.name),
      skills: this.config.resolved.skills.map(s => s.name),
      model: this.config.env.model,
      cwd: this.config.env.cwd,
      mcp_servers: [],
      permission_mode: 'bypassPermissions',
      system_prompt: systemPrompt,
    } as SDKMessage

    // Agentic loop
    let turnsRemaining = this.config.maxTurns
    let budgetExceeded = false
    let maxOutputRecoveryAttempts = 0
    let streamTruncated = false
    const MAX_OUTPUT_RECOVERY = 3

    // Expire an all-terminal TodoList left over from a PREVIOUS query. This runs
    // once at the start of each new user query, NOT inside the per-turn loop, so
    // a list the model marks completed mid-query survives for in-query visibility
    // and is only cleared when the NEXT query begins. See issue #32.
    if (this.config.sessionId) {
      try {
        const todos = await getTodos(this.config.sessionId)
        if (todos.length > 0 && !hasActiveTodos(todos)) {
          await clearTodos(this.config.sessionId)
        }
      } catch {
        // todos file unreadable — nothing to expire
      }
    }

    while (turnsRemaining > 0) {
      if (this.config.abortSignal?.aborted) break

      // Check budget
      if (this.config.maxBudgetUsd && this.totalCost >= this.config.maxBudgetUsd) {
        budgetExceeded = true
        break
      }

      // Auto-compact if context is too large
      if (shouldAutoCompact(this.compactState, this.config.env.model, this.config.contextWindow)) {
        for await (const ev of this.compactStream()) {
          yield ev
        }
      }

      // Session turns halved compaction: summarize the older half when over the limit
      if (this.config.maxSessionTurns && this.config.maxSessionTurns >= 2) {
        if (countSessionTurns(this.messages) > this.config.maxSessionTurns) {
          let sessionSummary = ''
          for await (const ev of this.compactStream(Math.max(1, Math.floor(this.config.maxSessionTurns / 2)))) {
            if (ev.type === 'compact' && ev.phase === 'end') sessionSummary = ev.summary ?? ''
            yield ev
          }
          if (!sessionSummary) {
            // Summary failed: fall back to hard truncation so context always converges
            this.messages = truncateToLastNTurns(this.messages, this.config.maxSessionTurns)
          }
        }
      }

      // Micro-compact: truncate large tool results
      let apiMessages = microCompactMessages(
        normalizeMessagesForAPI(this.messages as any[]),
      ) as NormalizedMessageParam[]

      // Enforce request body size limit: strip images from oldest messages if needed
      const maxBodyBytes = this.config.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES
      const bodySizeResult = enforceBodySizeLimit(apiMessages, maxBodyBytes, systemPrompt)
      apiMessages = bodySizeResult.messages as NormalizedMessageParam[]
      if (bodySizeResult.strippedCount > 0) {
        this.messages = apiMessages
        yield {
          type: 'system',
          subtype: 'warning',
          message: `Request body exceeded ${maxBodyBytes} byte limit. ${bodySizeResult.strippedCount} image(s) removed from older messages.`,
        } as any
      }

      // Inject current todos snapshot as a system-reminder at turn boundary.
      // Best-effort: file errors are silently ignored (same policy as the <env> block).
      // Does NOT modify this.messages — the reminder is ephemeral, scoped to this turn's API call.
      // NB: all-terminal leftovers from a PREVIOUS query are expired once at the
      // start of this query (see the cleanup block before the agentic loop), so
      // any non-empty list here is either active work or a list the model itself
      // produced mid-query — both are useful in-query visibility.
      if (this.config.sessionId) {
        try {
          const todos = await getTodos(this.config.sessionId)
          if (todos.length > 0) {
            const reminder = formatTodosReminder(todos)
            apiMessages = [
              ...apiMessages,
              { role: 'user', content: reminder } as NormalizedMessageParam,
            ]
          }
        } catch {
          // todos file unreadable — skip injection this turn
        }
      }

      // Build per-turn tools: eager + activated deferred schemas.
      // Recomputed every turn because activatedTools may grow during the query
      // (e.g. the model called ToolSearch in turn N — those schemas appear in turn N+1).
      const eagerTools = this.config.resolved.tools.map(toProviderTool)
      const activatedNames = this.config.env.toolServices?.toolSearch?.activatedTools ?? new Set<string>()
      const activatedDeferred = this.config.resolved.deferredTools
        .filter(t => activatedNames.has(t.name))
        .map(toProviderTool)
      const tools = [...eagerTools, ...activatedDeferred]

      this.turnCount++
      turnsRemaining--

      // Make API call with retry via provider
      let response: CreateMessageResponse
      const apiStart = performance.now()

      try {
        if (this.config.includePartialMessages) {
          // Check if provider supports streaming
          if (!this.provider.createMessageStream) {
            throw new Error('Streaming not supported by this provider')
          }

          const chunks: import('./providers/types.js').StreamChunk[] = []
          const streamUsage: any = { input_tokens: 0, output_tokens: 0, totalInputTokens: 0 }
          const seenToolUseIndices = new Set<number>()

          const streamFn = () => this.provider.createMessageStream!({
            model: this.config.env.model,
            maxTokens: this.config.env.maxTokens,
            system: systemPrompt,
            messages: apiMessages,
            tools: tools.length > 0 ? tools : undefined,
            thinking:
              this.config.thinking?.type === 'enabled'
                ? {
                    type: 'enabled',
                    budget_tokens: this.config.thinking.budgetTokens,
                  }
                : undefined,
            effort: this.config.effort,
            signal: this.config.abortSignal,
          })

          try {
            for await (const item of withStreamRetry(streamFn, {
              maxRetries: this.config.maxStreamRetries ?? DEFAULT_MAX_STREAM_RETRIES,
              classify: classifyStreamError,
              getDelay: getStreamRetryDelay,
              abortSignal: this.config.abortSignal,
            })) {
              if ((item as any).type === 'retry') {
                const retryEvent = item as RetryEvent
                yield {
                  type: 'system',
                  subtype: 'retry',
                  attempt: retryEvent.attempt,
                  error_type: retryEvent.errorType as SDKRetryMessage['error_type'],
                  delay_ms: retryEvent.delayMs,
                } as SDKRetryMessage
                continue
              }

              if (this.config.abortSignal?.aborted) break

              const chunk = item as import('./providers/types.js').StreamChunk
              chunks.push(chunk)

              if (chunk.warnings && chunk.warnings.length > 0) {
                for (const w of chunk.warnings) {
                  yield { type: 'system', subtype: 'warning', message: w } as any
                }
              }

              if (chunk.type === 'usage' && chunk.usage) {
                streamUsage.input_tokens = chunk.usage.input_tokens
                streamUsage.output_tokens = chunk.usage.output_tokens
                streamUsage.totalInputTokens = chunk.usage.totalInputTokens || chunk.usage.input_tokens
                streamUsage.cache_creation_input_tokens = chunk.usage.cache_creation_input_tokens
                streamUsage.cache_read_input_tokens = chunk.usage.cache_read_input_tokens
                if (chunk.rawUsage) {
                  streamUsage.rawUsage = chunk.rawUsage
                }
              }

              if (chunk.type === 'tool_use') {
                if (!seenToolUseIndices.has(chunk.index)) {
                  seenToolUseIndices.add(chunk.index)
                  yield {
                    type: 'partial_message',
                    partial: {
                      type: 'tool_use',
                      tool_name: chunk.name || '',
                      tool_use_id: chunk.id || '',
                    },
                  }
                }
              }

              if (chunk.type === 'text' || chunk.type === 'thinking') {
                yield {
                  type: 'partial_message',
                  partial: {
                    type: chunk.type,
                    text: chunk.delta || '',
                  },
                }
              }
            }
          } catch (err: any) {
            // Persist partial chunks on any error (mid-stream or abort);
            // rethrow only if we got nothing.
            if (chunks.length === 0) throw err
            streamTruncated = true
          }

          response = buildResponseFromChunks(chunks)
          if (streamUsage.input_tokens > 0 || streamUsage.output_tokens > 0) {
            response.usage = streamUsage
          }
          if (streamUsage.rawUsage) {
            response.rawUsage = streamUsage.rawUsage
          }
        } else {
          // Non-streaming mode
          response = await withRetry(
            async () => {
              return this.provider.createMessage({
                model: this.config.env.model,
                maxTokens: Math.min(this.config.env.maxTokens, MAX_TOKENS_NON_STREAMING),
                system: systemPrompt,
                messages: apiMessages,
                tools: tools.length > 0 ? tools : undefined,
                thinking:
                  this.config.thinking?.type === 'enabled'
                    ? {
                      type: 'enabled',
                      budget_tokens: this.config.thinking.budgetTokens,
                    }
                    : undefined,
                effort: this.config.effort,
              })
            },
            undefined,
            this.config.abortSignal,
          )

          if (response.warnings && response.warnings.length > 0) {
            for (const w of response.warnings) {
              yield { type: 'system', subtype: 'warning', message: w } as any
            }
          }
        }
      } catch (err: any) {
        // Handle prompt-too-long by compacting
        if (isPromptTooLongError(err) && !this.compactState.compacted) {
          try {
            const result = await compactConversation(
              this.provider,
              this.config.env.model,
              this.messages as any[],
              this.compactState,
            )
            this.messages = result.compactedMessages as NormalizedMessageParam[]
            this.compactState = result.state
            // All messages were summarized — nothing to revert to
            this._compactBoundaryId = undefined
            turnsRemaining++ // Retry this turn
            this.turnCount--
            continue
          } catch {
            // Can't compact, give up
          }
        }

        yield {
          type: 'result',
          subtype: 'error',
          error_type: classifyStreamError(err).type,
          usage: { ...this.totalUsage },
          num_turns: this.turnCount,
          cost: this.totalCost,
          errors: [err.message],
        }
        return
      }

      // Track API timing
      this.apiTimeMs += performance.now() - apiStart

      // Track usage (normalized by provider)
      if (response.usage) {
        this.totalUsage.input_tokens = response.usage.input_tokens
        this.totalUsage.output_tokens = response.usage.output_tokens
        this.totalUsage.cache_creation_input_tokens = response.usage.cache_creation_input_tokens
        this.totalUsage.cache_read_input_tokens = response.usage.cache_read_input_tokens
        this.totalUsage.total_input_tokens = response.usage.totalInputTokens
        this.totalCost += estimateCost(this.config.env.model, response.usage)
        this.compactState.lastInputTokens = response.usage.totalInputTokens || response.usage.input_tokens
        this.compactState.lastOutputTokens = response.usage.output_tokens
      }

      pruneMessages(this.messages)

      // Add assistant message to conversation (same UUID that will be yielded)
      const assistantUuid = crypto.randomUUID()
      this.messages.push({ role: 'assistant', content: response.content as any, rawUsage: response.rawUsage, id: assistantUuid })

      // Yield assistant message
      yield {
        type: 'assistant',
        uuid: assistantUuid,
        message: {
          role: 'assistant',
          content: response.content as any,
        },
        usage: response.usage,
      }

      // Handle max_output_tokens recovery
      if (response.stopReason === 'max_tokens' && maxOutputRecoveryAttempts < MAX_OUTPUT_RECOVERY) {
        const hasToolUse = response.content.some((b: any) => b.type === 'tool_use')

        if (hasToolUse) {
          yield {
            type: 'system',
            subtype: 'warning',
            message: `Output truncated (max_tokens). Tool call(s) may have incomplete arguments.`,
          } as any
        } else {
          yield {
            type: 'system',
            subtype: 'warning',
            message: `Output truncated (max_tokens). Text response was cut off.`,
          } as any
          maxOutputRecoveryAttempts++
          this.messages.push({
            role: 'user',
            id: crypto.randomUUID(),
            content: 'Please continue from where you left off.',
          })
          continue
        }
      }

      // Check for tool use
      const toolUseBlocks = response.content.filter(
        (block): block is ToolUseBlock => block.type === 'tool_use',
      )

      if (toolUseBlocks.length === 0) {
        break // No tool calls - agent is done
      }

      // Reset max_output recovery counter on successful tool use
      maxOutputRecoveryAttempts = 0

      // Sanitize assistant message: ensure tool_use input is an object (not raw string)
      // so the API accepts it on subsequent turns. Must happen BEFORE executeTools so
      // the transcript is consistent even if generator is force-returned during yield.
      //
      // Contract: at this point in the flow, the last message in this.messages is
      // the assistant message we just decoded from the stream (no user/tool_result
      // message has been pushed yet — that happens inside executeTools below).
      // If Task 3 or later inserts any intermediate message between stream
      // completion and this sanitize, the `length - 1` index will silently point
      // at the wrong message. The `role === 'assistant'` guard below is the
      // runtime assertion of this contract — if it fails, sanitize is a no-op
      // rather than corrupting an unrelated message.
      const assistantMsgPreExec = this.messages[this.messages.length - 1]
      if (assistantMsgPreExec?.role === 'assistant' && Array.isArray(assistantMsgPreExec.content)) {
        for (const block of assistantMsgPreExec.content as any[]) {
          if (block.type === 'tool_use' && typeof block.input === 'string') {
            block.input = {}
          }
        }
      }

      // Yield warning if any tool call had truncated input
      const truncatedCount = toolUseBlocks.filter((b) => typeof b.input === 'string').length
      if (truncatedCount > 0) {
        yield {
          type: 'system',
          subtype: 'warning',
          message: `Output truncated. ${truncatedCount} tool call(s) had incomplete/unparseable JSON arguments.`,
        } as any
      }

      // Stream events from executeTools (subagent + tool_result real-time,
      // tools_complete at end of batch). Aborts break out of the loop.
      const toolCtx: import('./engine/tool-executor.js').ToolExecutionContext = {
        config: this.config,
        messages: this.messages,
        sessionId: this.sessionId,
        hooks: this.hookRegistry,
        logger: this.logger.child({ component: 'tool-executor' }),
      }
      for await (const event of executeToolsFn(toolCtx, toolUseBlocks)) {
        if (this.config.abortSignal?.aborted) break
        yield event as any
      }

      if (response.stopReason === 'end_turn') break
    }

    // Hook: Stop (end of agentic loop)
    await this.executeHooks('Stop')

    // Hook: SessionEnd
    await this.executeHooks('SessionEnd')

    // Yield enriched final result
    const endSubtype = budgetExceeded
      ? 'error_max_budget_usd'
      : turnsRemaining <= 0
        ? 'error_max_turns'
        : 'success'

    yield {
      type: 'result',
      subtype: endSubtype,
      session_id: this.sessionId,
      is_error: endSubtype !== 'success',
      num_turns: this.turnCount,
      total_cost_usd: this.totalCost,
      duration_api_ms: Math.round(this.apiTimeMs),
      usage: { ...this.totalUsage },
      model_usage: { [this.config.env.model]: { input_tokens: this.totalUsage.input_tokens, output_tokens: this.totalUsage.output_tokens } },
      cost: this.totalCost,
      truncated: streamTruncated || undefined,
    }
  }

  /**
   * Get current messages for session persistence.
   */
  getMessages(): NormalizedMessageParam[] {
    return [...this.messages]
  }

  /**
   * Take a deep-copy snapshot of the current engine state.
   * Used by RevertService for conversation rollback.
   */
  snapshot(): EngineSnapshot {
    return {
      messages: this.messages.map((msg) => ({
        ...msg,
        content: typeof msg.content === 'string'
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.map((b: any) => ({ ...b }))
            : msg.content,
      })),
      totalUsage: { ...this.totalUsage },
      totalCost: this.totalCost,
      turnCount: this.turnCount,
    }
  }

  /**
   * Restore engine state from a snapshot.
   * Modifies messages in-place so existing array references stay valid.
   */
  restore(snap: EngineSnapshot): void {
    this.messages.length = 0
    this.messages.push(...snap.messages.map((msg) => ({
      ...msg,
      content: typeof msg.content === 'string'
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.map((b: any) => ({ ...b }))
          : msg.content,
    })))
    this.totalUsage = { ...snap.totalUsage }
    this.totalCost = snap.totalCost
    this.turnCount = snap.turnCount
  }

  /**
   * ID of the oldest message that survived auto-compaction.
   * Messages before this boundary were summarized and can no longer be reverted to.
   */
  get compactBoundaryId(): string | undefined {
    return this._compactBoundaryId
  }

  getUsage(): TokenUsage {
    return { ...this.totalUsage }
  }

  /**
   * Get total cost.
   */
  getCost(): number {
    return this.totalCost
  }

  /**
   * Get current compact state for persistence.
   */
  getState(): { lastInputTokens: number; lastOutputTokens: number } {
    return {
      lastInputTokens: this.compactState.lastInputTokens,
      lastOutputTokens: this.compactState.lastOutputTokens,
    }
  }

  /**
   * Manually trigger compaction of the current conversation.
   *
   * Summarizes older history while protecting the most recent turns, firing
   * PreCompact/PostCompact hooks. Streams `compact` events (start/progress/end)
   * so callers can surface progress (e.g. a `/compact` command). This is the
   * same algorithm used by auto-compaction, so behavior is identical.
   */
  async *compactStream(protectedTurns?: number): AsyncGenerator<SDKCompactMessage> {
    await this.executeHooks('PreCompact')
    try {
      const gen = compactConversationWithProtectedTail(
        this.provider,
        this.config.env.model,
        this.messages,
        this.compactState,
        protectedTurns,
      )
      while (true) {
        const next = await gen.next()
        if (next.done) {
          this.messages = next.value.messages
          this.compactState = next.value.state
          // Record compact boundary: first surviving message after summary
          // Compacted messages = [summary-user, summary-assistant, ...tail, lastMsg]
          // tail starts at index 2
          if (this.messages.length > 2) {
            const tailStart = this.messages[2]
            this._compactBoundaryId = tailStart?.id
          }
          break
        }
        yield next.value
      }
      await this.executeHooks('PostCompact')
    } catch {
      // Leave messages unchanged on failure; skip PostCompact
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
}

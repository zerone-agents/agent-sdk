/**
 * Tool executor — extracted from engine.ts
 *
 * Manages tool execution within the agentic loop:
 * - `executeTools()` — streaming generator that runs a batch of tool calls
 *   and yields events (tool_result, subagent, tools_complete).
 * - `executeSingleTool()` — runs one tool with permission checking and
 *   hook lifecycle (PreToolUse / PostToolUse / PostToolUseFailure).
 * - `runToolsBackground()` — orchestrates read-only (concurrent) vs
 *   mutation (serial) tool execution within a batch.
 *
 * All state needed for execution is passed via `ToolExecutionContext`,
 * making these functions independently testable without a full QueryEngine.
 */

import type {
  QueryEngineConfig,
  ToolDefinition,
  ToolResult,
  ToolContext,
  SkillContext,
  SubagentContext,
  SDKMessage,
  SDKSubagentMessage,
  SDKToolResultMessage,
  SDKToolsCompleteMessage,
} from '../types.js'
import type { NormalizedMessageParam } from '../providers/types.js'
import { AsyncQueue } from '../utils/async-queue.js'
import type { HookRegistry } from '../hooks.js'
import type { Logger } from '../utils/logger.js'
import { adaptToDiagnosticsSink, stableErrorType } from '../utils/diagnostics.js'
import { ellipsize, formatInputPreview, redactSensitiveFields } from '../utils/helpers.js'
import { normalizeToolInput, describeJsonValue, type ToolInputFormatError } from '../utils/tool-input.js'

/**
 * #137: render a compact expected-shape hint per missing field, derived from
 * inputSchema.properties — so the model can fix the call in ONE retry.
 * Constraints render independently (enum AND array bounds are never mutually
 * exclusive); entries are `any`, so every access is defensive. Fields absent
 * from properties are skipped gracefully (no hint line).
 */
export function renderExpectedShape(
  missing: string[],
  properties: Record<string, any> | undefined,
): string[] {
  return missing.flatMap((key) => {
    const p = properties?.[key]
    if (!p || typeof p !== 'object') return []
    const type = typeof p.type === 'string' ? p.type : 'value'
    let shape = `${key}: ${type}`
    if (p.type === 'array') {
      if (typeof p.minItems === 'number' && typeof p.maxItems === 'number') {
        shape += ` (${p.minItems}-${p.maxItems} items)`
      } else if (typeof p.minItems === 'number') {
        shape += ` (>=${p.minItems} items)`
      } else if (typeof p.maxItems === 'number') {
        shape += ` (<=${p.maxItems} items)`
      }
    }
    if (Array.isArray(p.enum) && p.enum.length > 0) {
      shape += ` (${p.enum.map(String).join(' | ')})`
    } else if (
      p.type === 'array' && p.items && typeof p.items === 'object'
      && Array.isArray(p.items.enum) && p.items.enum.length > 0
    ) {
      shape += ` (items: ${p.items.enum.map(String).join(' | ')})`
    }
    if (typeof p.description === 'string' && p.description.length > 0) {
      shape += ` — ${ellipsize(p.description, 80)}`
    }
    return [`- ${shape}`]
  })
}

// ============================================================================
// Types
// ============================================================================

/**
 * Internal type for extracted tool_use blocks from a response.
 */
export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}

/**
 * Events yielded by `executeTools()`.
 */
export type ToolExecutorEvent =
  | SDKSubagentMessage
  | SDKToolResultMessage
  | SDKToolsCompleteMessage

/**
 * Permission check result.
 */
export interface ToolPermissionResult {
  behavior: 'allow' | 'deny'
  message?: string
  updatedInput?: unknown
}

/**
 * Everything the tool executor needs from the engine.
 *
 * Instead of reaching into `this.config`, `this.messages`, `this.hooks`, etc.,
 * the engine passes a single context object. This keeps the executor decoupled
 * and testable.
 */
export interface ToolExecutionContext {
  config: Pick<
    QueryEngineConfig,
    'runtime' | 'resolved' | 'subAgents' | 'canUseTool' | 'abortSignal' | 'agentId' | 'store' | 'coordinator' | 'ownership'
  >
  messages: NormalizedMessageParam[]
  sessionId: string
  hooks?: HookRegistry
  logger: Logger
  /**
   * #144: format errors recorded by the engine's pre-execution input
   * normalization (engine path), keyed by tool_use id. The transcript block
   * already carries `{}` for API validity — the executor must report THIS
   * error instead of a misleading missing-required-fields validation error.
   */
  toolInputErrors?: Map<string, ToolInputFormatError>
}

// Superset context handed to every tool call: base ToolContext + SkillContext + SubagentContext.
type EngineToolContext = ToolContext & SkillContext & SubagentContext

// ============================================================================
// Helpers
// ============================================================================

/** #144: fire PostToolUseFailure for input-format failures, consistent with the validation-failure path. */
async function fireInputFailureHook(ctx: ToolExecutionContext, block: ToolUseBlock): Promise<void> {
  if (!ctx.hooks) return
  try {
    await ctx.hooks.execute('PostToolUseFailure', {
      event: 'PostToolUseFailure',
      toolName: block.name,
      toolInput: block.input,
      toolUseId: block.id,
      error: 'invalid tool input format',
    })
  } catch {
    // Hook errors are non-fatal
  }
}

/** Best-effort short preview of a non-string input value. */
function safePreview(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v)
  } catch {
    return String(v)
  }
}

/**
 * #144: LLM-visible format error. Wording is tailored to the failure kind
 * (malformed JSON / valid JSON string wrapping malformed inner JSON / value
 * is not an object); raw excerpts are bounded; the expected shape is reused
 * from #137 so the model can fix the call in one retry. Applies to ALL tools.
 */
function buildInputFormatError(name: string, info: ToolInputFormatError, tool?: ToolDefinition): string {
  const lines = [`Invalid input format for "${name}".`]
  if (info.kind === 'invalid-json') {
    lines.push('Expected a JSON object, but received malformed JSON.')
  } else if (info.kind === 'malformed-inner') {
    lines.push('Expected a JSON object, but received a JSON-encoded string containing malformed JSON.')
  } else {
    lines.push(`Expected a JSON object, but received ${info.received ?? 'a non-object value'}.`)
  }
  if (info.offset !== undefined) lines.push(`Parse error near offset ${info.offset}.`)
  lines.push('', 'Raw input (first 500 chars):', info.raw.slice(0, 500))
  if (tool?.inputSchema?.properties) {
    const shapeHints = renderExpectedShape(
      tool.inputSchema.required ?? Object.keys(tool.inputSchema.properties),
      tool.inputSchema.properties,
    )
    if (shapeHints.length > 0) lines.push('', 'Expected shape:', ...shapeHints)
  }
  if (info.kind === 'malformed-inner') {
    lines.push(
      '',
      'Pass the arguments object directly, without wrapping the entire object in quotes.',
      'Escape double quotes inside string values.',
    )
  } else if (info.kind === 'invalid-json') {
    lines.push('', 'Pass the arguments as a single JSON object.')
  }
  lines.push('', 'Please correct the input and try again.')
  return lines.join('\n')
}

/** Format a ToolResult into the SDKToolResultMessage['result'] shape. */
function formatResult(
  r: ToolResult & { tool_name?: string },
): SDKToolResultMessage['result'] {
  return {
    tool_use_id: r.tool_use_id,
    tool_name: r.tool_name || '',
    output:
      typeof r.content === 'string'
        ? r.content
        : Array.isArray(r.content)
          ? (r.content as any[])
              .map((b) => (b.type === 'text' ? b.text : `[${b.type}]`))
              .join('\n')
          : JSON.stringify(r.content),
    is_error: r.is_error,
    metadata: r.metadata,
  }
}

/** Check if a tool definition marks itself as read-only. */
function isReadOnlyTool(tool?: ToolDefinition): boolean {
  return tool?.isReadOnly?.() ?? false
}

// ============================================================================
// executeTools — streaming generator
// ============================================================================

/**
 * Execute a batch of tool calls, streaming events as they arrive.
 *
 * Read-only tools run concurrently (batched by MAX_CONCURRENCY), mutations
 * run serially. Tool results are streamed immediately via an AsyncQueue.
 * On abort, incomplete tools receive synthetic "aborted" results.
 *
 * Always persists the transcript (tool_result messages) to `ctx.messages`
 * in the `finally` block — even on force-return from the generator.
 */
export async function* executeTools(
  ctx: ToolExecutionContext,
  toolUseBlocks: ToolUseBlock[],
): AsyncGenerator<ToolExecutorEvent> {
  const queue = new AsyncQueue<ToolExecutorEvent>()
  const results: Array<ToolResult & { tool_name?: string }> = []

  const emitSubagentEvent = (event: SDKSubagentMessage) => {
    queue.push(event)
  }

  const onComplete = (r: ToolResult & { tool_name?: string }) => {
    results.push(r)
    // C3: stream tool_result immediately (do NOT buffer)
    queue.push({ type: 'tool_result', result: formatResult(r) })
  }

  const allDone = runToolsBackground(
    ctx,
    toolUseBlocks,
    emitSubagentEvent,
    onComplete,
  ).then(() => {
    queue.close()
  })

  try {
    // Stream events (subagent + tool_result) as they arrive.
    // Poll abort signal with 50ms timeout to avoid blocking indefinitely
    // when queue is empty but abort fires.
    let abortedDuringDrain = false
    while (true) {
      if (ctx.config.abortSignal?.aborted) {
        abortedDuringDrain = true
        break
      }

      const timeoutPromise = new Promise<IteratorResult<ToolExecutorEvent>>(
        (resolve) => {
          setTimeout(
            () => resolve({ value: undefined as any, done: false }),
            50,
          )
        },
      )

      const item = await Promise.race([queue.next(), timeoutPromise])
      if (item.done) break
      if (item.value === undefined) continue // timeout, check abort
      yield item.value
    }

    // Only await allDone if we didn't abort. Give tools a brief grace period
    // (100ms) on abort to complete before computing synthetic results.
    if (!abortedDuringDrain) {
      await allDone
    } else {
      await Promise.race([
        allDone,
        new Promise((resolve) => setTimeout(resolve, 100)),
      ])
    }

    // Compute fill-in (synthetic results) for tools that did not produce
    // a real result.
    const completedIds = new Set(results.map((r) => r.tool_use_id))
    const synthetic: Array<ToolResult & { tool_name?: string }> = []
    for (const block of toolUseBlocks) {
      if (!completedIds.has(block.id)) {
        const s: ToolResult & { tool_name?: string } = {
          type: 'tool_result',
          tool_use_id: block.id,
          content: 'Tool execution aborted by user',
          is_error: true,
          tool_name: block.name,
        }
        results.push(s)
        synthetic.push(s)
      }
    }

    // Yield synthetic fill-in tool_results
    for (const s of synthetic) {
      yield { type: 'tool_result', result: formatResult(s) }
    }

    // Yield tools_complete (always last in the batch)
    yield {
      type: 'tools_complete',
      tool_use_ids: toolUseBlocks.map((b) => b.id),
      tool_results_count: results.length,
      results: results.map((r) => ({
        tool_use_id: r.tool_use_id,
        tool_name: r.tool_name || '',
        is_error: !!r.is_error,
      })),
    }
  } finally {
    // Force-return safety: ensure transcript is consistent even if the
    // generator was force-returned during any yield above.
    const completedIds = new Set(results.map((r) => r.tool_use_id))
    for (const block of toolUseBlocks) {
      if (!completedIds.has(block.id)) {
        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: 'Tool execution aborted by user',
          is_error: true,
          tool_name: block.name,
        })
      }
    }

    // Persist transcript. Always runs — on normal completion AND on
    // force-return from any yield in the try block above.
    ctx.messages.push({
      role: 'user',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      content: results.map((r) => ({
        type: 'tool_result' as const,
        tool_use_id: r.tool_use_id,
        content: r.content,
        is_error: r.is_error,
      })),
    })
  }
}

// ============================================================================
// runToolsBackground — concurrent/serial orchestration
// ============================================================================

/**
 * Execute all tools: read-only batched concurrently, mutations serially.
 *
 * Calls `onComplete` for each tool as it finishes. Calls `emitSubagentEvent`
 * for subagent events generated inside tools (Task/MultiTask).
 *
 * Per-tool errors (including PreToolUse hook errors that escape
 * executeSingleTool's internal try/catch) are caught and converted to
 * is_error tool_results. One tool's failure does NOT abort the batch.
 */
export async function runToolsBackground(
  ctx: ToolExecutionContext,
  toolUseBlocks: ToolUseBlock[],
  emitSubagentEvent: (event: SDKSubagentMessage) => void,
  onComplete: (r: ToolResult & { tool_name?: string }) => void,
): Promise<void> {
  const MAX_CONCURRENCY = parseInt(
    process.env.AGENT_SDK_MAX_TOOL_CONCURRENCY || '10',
  )

  const readOnly: Array<{ block: ToolUseBlock; tool?: ToolDefinition }> = []
  const mutations: Array<{ block: ToolUseBlock; tool?: ToolDefinition }> = []

  // Build the lookup pool: eager tools + activated deferred tools.
  // Deferred tools only become callable after the model calls FindTool to
  // load their schema (engine.ts rebuilds the provider tools array per turn
  // based on activatedTools). We mirror that here so tool-executor can
  // dispatch tool_use blocks for tools activated earlier in the same query.
  const activatedNames = ctx.config.resolved.services.findTool.activatedTools
  const deferredPool = activatedNames && activatedNames.size > 0
    ? ctx.config.resolved.deferredTools.filter(t => activatedNames.has(t.name))
    : []
  const lookupPool = [...ctx.config.resolved.tools, ...deferredPool]

  for (const block of toolUseBlocks) {
    const tool = lookupPool.find((t) => t.name === block.name)
    if (isReadOnlyTool(tool)) {
      readOnly.push({ block, tool })
    } else {
      mutations.push({ block, tool })
    }
  }

  const makeContext = (block: ToolUseBlock): EngineToolContext => ({
    cwd: ctx.config.runtime.cwd,
    abortSignal: ctx.config.abortSignal,
    agentId: ctx.config.agentId,
    sessionId: ctx.sessionId,
    // issue #131 P3: tools (TodoWrite) persist through the v4 coordinator.
    store: ctx.config.store,
    coordinator: ctx.config.coordinator,
    ownership: ctx.config.ownership,
    toolUseId: block.id,
    // Per-agent tool services (use provided or create empty)
    services: ctx.config.resolved.services,
    // Pre-computed subprocess env for Bash/Grep
    subprocessEnv: ctx.config.runtime.subprocessEnv,
    // #78: surface the engine's logger (adapted) so tools — e.g. subagent
    // launchers — can forward the diagnostics channel to children.
    diagnostics: adaptToDiagnosticsSink(ctx.logger),
    // SkillContext
    resolvedSkills: ctx.config.resolved.skills,
    skillRegistry: ctx.config.resolved.skillRegistry,
    // SubagentContext
    runtime: ctx.config.runtime,
    subAgents: ctx.config.subAgents ?? {},
    emitEvent: emitSubagentEvent
      ? (event: SDKMessage) => {
          if (event.type === 'subagent') {
            emitSubagentEvent({
              ...event,
              parent_tool_use_id: block.id,
            })
          }
        }
      : undefined,
  })

  // Execute read-only tools concurrently (batched by MAX_CONCURRENCY)
  for (let i = 0; i < readOnly.length; i += MAX_CONCURRENCY) {
    if (ctx.config.abortSignal?.aborted) break
    const batch = readOnly.slice(i, i + MAX_CONCURRENCY)
    const batchPromises = batch.map(async (item) => {
      try {
        const r = await executeSingleTool(
          ctx,
          item.block,
          item.tool,
          makeContext(item.block),
        )
        onComplete(r)
      } catch (err: any) {
        onComplete({
          type: 'tool_result',
          tool_use_id: item.block.id,
          content: `Tool execution error: ${err.message}`,
          is_error: true,
          tool_name: item.block.name,
        })
      }
    })
    await Promise.all(batchPromises)
  }

  // Execute mutation tools sequentially
  for (const item of mutations) {
    if (ctx.config.abortSignal?.aborted) break
    try {
      const r = await executeSingleTool(
        ctx,
        item.block,
        item.tool,
        makeContext(item.block),
      )
      onComplete(r)
    } catch (err: any) {
      onComplete({
        type: 'tool_result',
        tool_use_id: item.block.id,
        content: `Tool execution error: ${err.message}`,
        is_error: true,
        tool_name: item.block.name,
      })
    }
  }
}

// ============================================================================
// executeSingleTool — single tool with permission + hooks
// ============================================================================

/**
 * Execute a single tool with permission checking, input validation,
 * and hook lifecycle (PreToolUse / PostToolUse / PostToolUseFailure).
 *
 * Returns a ToolResult augmented with the tool name. Errors from the
 * tool call itself are caught and returned as is_error results.
 */
export async function executeSingleTool(
  ctx: ToolExecutionContext,
  block: ToolUseBlock,
  tool: ToolDefinition | undefined,
  toolContext: ToolContext & SkillContext & SubagentContext,
): Promise<ToolResult & { tool_name?: string }> {
  const log = ctx.logger

  if (!tool) {
    return {
      type: 'tool_result',
      tool_use_id: block.id,
      content: `Error: Unknown tool "${block.name}"`,
      is_error: true,
      tool_name: block.name,
    }
  }

  // Validate input format BEFORE schema-required-field validation (issue #144).
  // 1) Engine path: the pre-execution normalization recorded a format error for
  //    this tool_use id (the transcript block was left as {} for API validity).
  const recordedFormatError = ctx.toolInputErrors?.get(block.id)
  if (recordedFormatError) {
    await fireInputFailureHook(ctx, block)
    return {
      type: 'tool_result',
      tool_use_id: block.id,
      content: buildInputFormatError(block.name, recordedFormatError, tool),
      is_error: true,
      tool_name: block.name,
    }
  }

  // 2) Direct string input (non-engine callers): attempt bounded recovery —
  //    a valid double-encoded JSON object is decoded once more and executed.
  if (typeof block.input === 'string') {
    const norm = normalizeToolInput(block.input)
    if (norm.ok) {
      block.input = norm.value
    } else {
      await fireInputFailureHook(ctx, block)
      return {
        type: 'tool_result',
        tool_use_id: block.id,
        content: buildInputFormatError(block.name, { ...norm, raw: block.input }, tool),
        is_error: true,
        tool_name: block.name,
      }
    }
  }

  // 3) Non-string values that are still not plain objects (array/null/scalars):
  //    expected-object error, never a misleading missing-fields error.
  if (block.input !== undefined && (block.input === null || typeof block.input !== 'object' || Array.isArray(block.input))) {
    await fireInputFailureHook(ctx, block)
    return {
      type: 'tool_result',
      tool_use_id: block.id,
      content: buildInputFormatError(
        block.name,
        { kind: 'not-an-object', raw: safePreview(block.input), received: describeJsonValue(block.input) },
        tool,
      ),
      is_error: true,
      tool_name: block.name,
    }
  }

  // Check enabled
  if (tool.isEnabled && !tool.isEnabled()) {
    return {
      type: 'tool_result',
      tool_use_id: block.id,
      content: `Error: Tool "${block.name}" is not enabled`,
      is_error: true,
      tool_name: block.name,
    }
  }

  // Check permissions
  if (ctx.config.canUseTool) {
    try {
      const permission = await ctx.config.canUseTool(tool, block.input)
      if (permission.behavior === 'deny') {
        return {
          type: 'tool_result',
          tool_use_id: block.id,
          content:
            permission.message ||
            [
              `Permission denied: the user rejected execution of tool "${block.name}".`,
              '',
              'Consider why the tool call was denied:',
              '- If the tool call parameters seem correct, try rephrasing or adjusting your approach instead of repeating the same call.',
              "- If you're unsure why the call was denied, ask the user for clarification.",
              '- If the task can be accomplished through an alternative method, try that approach instead.',
              '',
              'Do NOT retry the exact same tool call with identical parameters.',
            ].join('\n'),
          is_error: true,
          tool_name: block.name,
        }
      }
      if (permission.updatedInput !== undefined) {
        block = { ...block, input: permission.updatedInput }
      }
    } catch (err: any) {
      return {
        type: 'tool_result',
        tool_use_id: block.id,
        content: `Permission check error: ${err.message}`,
        is_error: true,
        tool_name: block.name,
      }
    }
  }

  // Hook: PreToolUse
  if (ctx.hooks) {
    try {
      const preHookResults = await ctx.hooks.execute('PreToolUse', {
        event: 'PreToolUse',
        toolName: block.name,
        toolInput: block.input,
        toolUseId: block.id,
      })
      // Check if any hook blocks this tool
      if (preHookResults.some((r) => r.block)) {
        const hookMsg = preHookResults.find((r) => r.message)?.message
        return {
          type: 'tool_result',
          tool_use_id: block.id,
          content: [
            `Blocked by PreToolUse hook: ${hookMsg || 'no reason provided'}`,
            '',
            'This tool call was blocked by a user-configured hook. Consider:',
            '- Adjusting your approach to avoid triggering the hook.',
            '- Asking the user to check their hooks configuration if this is unexpected.',
          ].join('\n'),
          is_error: true,
          tool_name: block.name,
        }
      }
    } catch {
      // Hook errors are non-fatal — proceed with execution
    }
  }

  // Validate tool input: check required fields exist
  if (block.input && typeof block.input === 'object' && tool.inputSchema?.required) {
    const input = block.input as Record<string, unknown>
    const missing = tool.inputSchema.required.filter(
      (key) => input[key] === undefined || input[key] === null,
    )
    if (missing.length > 0) {
      if (ctx.hooks) {
        try {
          await ctx.hooks.execute('PostToolUseFailure', {
            event: 'PostToolUseFailure',
            toolName: block.name,
            toolInput: block.input,
            toolUseId: block.id,
            error: `Missing required fields: ${missing.join(', ')}`,
          })
        } catch {
          // Hook errors are non-fatal
        }
      }
      // #137: show the expected shape of each missing field (from
      // inputSchema.properties) so the model can fix the call in ONE retry.
      const shapeHints = renderExpectedShape(missing, tool.inputSchema?.properties)
      const lines = [
        `Tool input validation failed for "${block.name}":`,
        `Missing required fields: ${missing.join(', ')}`,
      ]
      if (shapeHints.length > 0) lines.push('', 'Expected shape:', ...shapeHints)
      lines.push(
        '',
        'Input was:',
        JSON.stringify(block.input, null, 2).slice(0, 2000),
        '',
        'Please fix the input and try again.',
      )
      return {
        type: 'tool_result',
        tool_use_id: block.id,
        content: lines.join('\n'),
        is_error: true,
        tool_name: block.name,
      }
    }
  }

  // Execute the tool
  try {
    // Trace-only: tool execution metadata (name + tool_use_id). Demoted from
    // debug so the default `debug` level stays silent — useful only when
    // reconstructing turn boundaries during debugging.
    log.trace(`executeSingleTool(${block.name}) started tool_use_id=${block.id}`)
    // Trace (explicit opt-in): input preview with sensitive fields redacted.
    log.trace(
      `executeSingleTool(${block.name}) input=${formatInputPreview(redactSensitiveFields(block.input))}`,
    )
    const result = await tool.call(block.input, toolContext)

    // Hook: PostToolUse
    if (ctx.hooks) {
      try {
        await ctx.hooks.execute('PostToolUse', {
          event: 'PostToolUse',
          toolName: block.name,
          toolInput: block.input,
          toolOutput:
            typeof result.content === 'string'
              ? result.content
              : JSON.stringify(result.content),
          toolUseId: block.id,
        })
      } catch {
        // Hook errors are non-fatal
      }
    }

    return { ...result, tool_use_id: block.id, tool_name: block.name }
  } catch (err: any) {
    // Hook: PostToolUseFailure
    if (ctx.hooks) {
      try {
        await ctx.hooks.execute('PostToolUseFailure', {
          event: 'PostToolUseFailure',
          toolName: block.name,
          toolInput: block.input,
          toolUseId: block.id,
          error: err.message,
        })
      } catch {
        // Hook errors are non-fatal
      }
    }

    log.error(`executeSingleTool(${block.name}) error`, { errorType: stableErrorType(err) })
    return {
      type: 'tool_result',
      tool_use_id: block.id,
      content: `Tool execution error: ${err.message}`,
      is_error: true,
      tool_name: block.name,
    }
  }
}

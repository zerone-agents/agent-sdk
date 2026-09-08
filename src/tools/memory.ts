/**
 * Memory / MemorySearch Tools — thin adapters over MemoryService (issue #61).
 *
 * ADR 0005: the MemoryService is read from the per-Agent ToolServices
 * (context.services.memory) — no module-level globals, no singleton mutation.
 * Hosts wire it via AgentOptions.memoryService (injected into
 * toolServices.memory); resolveAgent mounts both tools ONLY when a service is
 * bound (conditionally, alongside the base pool — before allow/deny lists).
 *
 * Tool message contract (review-pinned): messages are FIXED strings + record
 * ids only — content is never echoed back, and unknown errors never surface
 * their raw message to the model (see unexpectedErrorResult).
 */

import type { ToolDefinition, ToolResult, ToolContext } from '../types.js'
import { stableErrorType } from '../utils/diagnostics.js' // #78 extractor (R3-P1)
import {
  MemoryAccessError,
  MemoryConflictError,
  MemoryNotFoundError,
  MemoryValidationError,
} from '../memory/errors.js'
import { MEMORY_IMPORTANCE_LABELS } from '../memory/render.js'
import { MEMORY_SEARCH_DEFAULT_LIMIT, MEMORY_SEARCH_MAX_LIMIT } from '../memory/search.js'
import type { MemoryRecord, MemoryReplaceChanges, MemoryScope } from '../memory/types.js'
import type { MemoryService } from '../memory/service.js'

const IMPORTANCE_BY_LABEL = { low: 25, medium: 50, high: 75, never_forget: 100 } as const
type ImportanceLabel = keyof typeof IMPORTANCE_BY_LABEL

/** Resolve the per-agent memory service from the tool context (ADR 0005). */
function memoryServiceFrom(context: ToolContext): MemoryService | null {
  return context.services?.memory ?? null
}

function errorResult(message: string): ToolResult {
  return { type: 'tool_result', tool_use_id: '', content: message, is_error: true }
}

function okResult(content: string): ToolResult {
  return { type: 'tool_result', tool_use_id: '', content }
}

/**
 * Round-2/3 review (R2-P1, R3-P1): NEVER rethrow unknown errors —
 * executeSingleTool writes uncaught err.message into the tool_result
 * returned to the model (verified: src/engine/tool-executor.ts:599-606) —
 * a storage error carrying file paths or content fragments would leak.
 * Returns a FIXED public message; the original error travels ONLY via the
 * #78 diagnostics channel. errorType comes from stableErrorType() — never
 * read user-controlled fields like err.name (a getter can throw and the
 * new exception would escape to the model-visible path, R3-P1). The sink
 * call itself is isolated: a throwing diagnostics sink must not change
 * the tool result either.
 */
function unexpectedErrorResult(context: ToolContext, err: unknown): ToolResult {
  try {
    context.diagnostics?.error(
      '[memory] Memory tool operation failed unexpectedly',
      { errorType: stableErrorType(err) },
      err instanceof Error ? err : new Error(String(err)),
    )
  } catch {
    // diagnostics must never affect the tool result (R3-P1)
  }
  return errorResult('Memory operation failed unexpectedly.')
}

function targetScope(target: string): MemoryScope {
  return target === 'memory' ? 'global' : target === 'user' ? 'user' : 'workspace'
}

/** One deterministic result line: id + scope + label + revision + status + preview. */
function formatSearchResult(record: MemoryRecord): string {
  const label = MEMORY_IMPORTANCE_LABELS[record.importance]
  const preview = record.content.length > 60 ? `${record.content.slice(0, 57)}...` : record.content
  return `[${record.id}] (${record.scope}, ${label}, rev ${record.revision}, ${record.status}) ${preview}`
}

export const MemoryTool: ToolDefinition = {
  name: 'Memory',
  description:
    'Persist, replace, or remove long-term memories across three scopes: memory (global), user, and workspace. ' +
    'Prior memories persist across sessions. Reads reflect the current record revision only — use MemorySearch to re-read before replace/remove.',
  shortDescription: 'Add, replace, or remove persistent memories',
  deferred: true,
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['add', 'replace', 'remove'], description: 'Operation to perform.' },
      target: { type: 'string', enum: ['memory', 'user', 'workspace'], description: 'Scope to write — REQUIRED for add only; replace/remove target the record itself (scope + bound workspace are validated against it).' },
      content: { type: 'string', description: 'Content to remember (add).' },
      new_text: { type: 'string', description: 'Replacement content (replace).' },
      record_id: { type: 'string', description: 'Record ID from MemorySearch (replace/remove).' },
      expected_revision: { type: 'number', description: 'Revision seen in MemorySearch; the write fails if the record changed (replace/remove).' },
      importance: { type: 'string', enum: ['low', 'medium', 'high', 'never_forget'], description: 'Retention priority.' },
    },
    required: ['action'],
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
  async prompt() {
    return 'Manage persistent memories.'
  },
  async call(input: any, context: ToolContext): Promise<ToolResult> {
    const service = memoryServiceFrom(context)
    if (!service) return errorResult('Memory service is not configured.')
    const { action } = input ?? {}
    if (typeof action !== 'string') {
      return errorResult('Memory requires action ("add" | "replace" | "remove").')
    }
    try {
      const session = await service.bind({
        actor: 'session', sessionId: context.sessionId, workspace: context.cwd,
      })
      if (action === 'add') {
        // ROUND-3 REVIEW (R3-P2): target is REQUIRED for add only — the App's
        // existing contract accepts `{action: "remove", record_id, expected_revision}`
        // without target; replace/remove are validated against the record's own
        // scope and the session's bound workspace (service-side access rules).
        if (typeof input?.target !== 'string') {
          return errorResult('add requires target ("memory" | "user" | "workspace").')
        }
        if (typeof input.content !== 'string' || typeof input.importance !== 'string') {
          return errorResult('add requires content and importance (low | medium | high | never_forget).')
        }
        const importance = IMPORTANCE_BY_LABEL[input.importance as ImportanceLabel]
        const result = await session.add({
          scope: targetScope(input.target), content: input.content, importance,
        })
        return okResult(
          `Memory saved: [${result.record!.id}] (${result.record!.scope}, ${MEMORY_IMPORTANCE_LABELS[result.record!.importance]}, rev ${result.record!.revision})`)
      }
      if (typeof input.record_id !== 'string' || typeof input.expected_revision !== 'number') {
        return errorResult('replace/remove require record_id and expected_revision from MemorySearch.')
      }
      if (action === 'remove') {
        await session.remove(input.record_id, input.expected_revision)
        return okResult(`Memory record ${input.record_id} removed (soft delete).`)
      }
      if (action === 'replace') {
        const changes: MemoryReplaceChanges = {}
        if (typeof input.new_text === 'string') changes.content = input.new_text
        if (typeof input.importance === 'string') changes.importance = IMPORTANCE_BY_LABEL[input.importance as ImportanceLabel]
        if (changes.content === undefined && changes.importance === undefined) {
          return errorResult('replace requires new_text and/or importance.')
        }
        const result = await session.replace(input.record_id, input.expected_revision, changes)
        return okResult(
          `Memory updated: [${result.record!.id}] (rev ${result.record!.revision})`)
      }
      return errorResult(`Unknown Memory action: ${action}`)
    } catch (err) {
      if (err instanceof MemoryConflictError) {
        return errorResult(`Memory record ${err.record.id} changed concurrently (current revision: ${err.record.revision}). Run MemorySearch and retry with the fresh revision.`)
      }
      if (err instanceof MemoryNotFoundError) {
        return errorResult(`Memory record ${err.recordId} no longer exists. Run MemorySearch to re-read.`)
      }
      if (err instanceof MemoryAccessError || err instanceof MemoryValidationError) {
        return errorResult(err.message)
      }
      return unexpectedErrorResult(context, err)
    }
  },
}

export const MemorySearchTool: ToolDefinition = {
  name: 'MemorySearch',
  description:
    'Search persistent memories across the global, user, and workspace scopes (active and archived records). ' +
    'Each result line exposes the record id, scope, importance, revision, and status — use the id and revision ' +
    'verbatim with the Memory tool to replace or remove a record.',
  shortDescription: 'Search persistent memories across scopes',
  deferred: true,
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search text; matches complete phrases first, then all terms.' },
      limit: { type: 'number', description: `Maximum result count (default ${MEMORY_SEARCH_DEFAULT_LIMIT}, capped at ${MEMORY_SEARCH_MAX_LIMIT}).` },
    },
    required: ['query'],
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() {
    return 'Search persistent memories.'
  },
  async call(input: any, context: ToolContext): Promise<ToolResult> {
    const service = memoryServiceFrom(context)
    if (!service) return errorResult('Memory service is not configured.')
    if (typeof input?.query !== 'string') {
      return errorResult('MemorySearch requires a query string.')
    }
    try {
      const session = await service.bind({
        actor: 'session', sessionId: context.sessionId, workspace: context.cwd,
      })
      const records = await session.search({
        text: input.query,
        ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
      })
      if (records.length === 0) return okResult('No memory records found.')
      return okResult(records.map(formatSearchResult).join('\n'))
    } catch (err) {
      if (err instanceof MemoryValidationError) {
        return errorResult(err.message) // invalid limit, etc.
      }
      return unexpectedErrorResult(context, err)
    }
  },
}
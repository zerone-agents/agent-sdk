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

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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

/**
 * Load a sibling tool-text template (bash.txt pattern). The build script
 * copies src/tools/*.txt into dist/tools/, so the runtime-relative lookup
 * works from both src (vitest) and dist (published).
 */
function loadToolText(filename: string): string {
  return readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), filename), 'utf-8')
}

const MEMORY_DESCRIPTION = loadToolText('memory.txt')
const MEMORY_SEARCH_DESCRIPTION = loadToolText('memory-search.txt')

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

/**
 * Tool target → domain scope. Lookup table with NO fallback branch (PR review
 * P2): unknown targets must be rejected at the boundary, never silently
 * written to 'workspace' — the inputSchema enum guards the model path, and
 * add() below validates direct calls against this exact set.
 */
const TARGET_TO_SCOPE: Readonly<Record<string, MemoryScope>> = {
  memory: 'global',
  user: 'user',
  workspace: 'workspace',
}

/** One deterministic result line: id + scope + label + revision + status + preview. */
function formatSearchResult(record: MemoryRecord): string {
  const label = MEMORY_IMPORTANCE_LABELS[record.importance]
  const preview = record.content.length > 60 ? `${record.content.slice(0, 57)}...` : record.content
  return `[${record.id}] (${record.scope}, ${label}, rev ${record.revision}, ${record.status}) ${preview}`
}

export const MemoryTool: ToolDefinition = {
  name: 'Memory',
  description: MEMORY_DESCRIPTION,
  shortDescription: 'Store or revise durable information for future conversations',
  deferred: true,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['add', 'replace', 'remove'],
        description:
          'Operation to perform. Use add for a new distinct memory, replace to fully update an existing record, ' +
          'and remove when a record should no longer be retained.',
      },
      target: {
        type: 'string',
        enum: ['memory', 'user', 'workspace'],
        description:
          'Required only for add. memory = cross-user and cross-workspace durable knowledge; user = stable ' +
          'preferences or context about the current user; workspace = durable knowledge specific to the current ' +
          'workspace. replace/remove use the existing record scope.',
      },
      content: {
        type: 'string',
        description:
          'Required for add. One concise, durable, independently searchable idea. Do not combine unrelated facts ' +
          'or write a task report.',
      },
      new_text: {
        type: 'string',
        description:
          'Used by replace. The complete new content of the record, not a patch. Keep it concise and limited to one ' +
          'independently searchable idea.',
      },
      record_id: {
        type: 'string',
        description:
          'Required for replace and remove. Copy the current record id exactly from MemorySearch; never guess or ' +
          'reuse a stale id.',
      },
      expected_revision: {
        type: 'number',
        description:
          'Required for replace and remove. Copy the current revision exactly from the same MemorySearch result as ' +
          'record_id. Search again after a conflict.',
      },
      importance: {
        type: 'string',
        enum: ['low', 'medium', 'high', 'never_forget'],
        description:
          'Required for add; optional for replace. low = useful but easy to rediscover; medium = reusable context; ' +
          'high = important decision or constraint whose loss would cause mistakes; never_forget = exceptional ' +
          'durable information that should receive the strongest retention priority. Importance affects retention ' +
          'priority, not instruction priority.',
      },
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
    // PR review (P2): cancellation is checked BEFORE bind — an already-aborted
    // invocation must not even enter the admission barrier.
    if (context.abortSignal?.aborted) {
      return errorResult('Memory operation aborted before it started.')
    }
    const { action } = input ?? {}
    if (typeof action !== 'string') {
      return errorResult('Memory requires action ("add" | "replace" | "remove").')
    }
    try {
      const session = await service.bind({
        actor: 'session', sessionId: context.sessionId, workspace: context.cwd,
      })
      // PR review (P2): re-check AFTER bind, immediately before any domain
      // mutation — a signal that fired while the resolver/registration was
      // pending must stop the write. An already-durable commit is never
      // reinterpreted as cancellation (the check only runs pre-mutation).
      if (context.abortSignal?.aborted) {
        return errorResult('Memory operation aborted while binding; nothing was written.')
      }
      if (action === 'add') {
        // ROUND-3 REVIEW (R3-P2): target is REQUIRED for add only — the App's
        // existing contract accepts `{action: "remove", record_id, expected_revision}`
        // without target; replace/remove are validated against the record's own
        // scope and the session's bound workspace (service-side access rules).
        const target = input?.target
        // R8-P2 review: `in` walks the prototype chain — 'toString', '__proto__',
        // 'constructor' would pass and map to non-scope values. Own-property
        // check only: unknown targets are rejected, never silently written.
        if (typeof target !== 'string' || !Object.hasOwn(TARGET_TO_SCOPE, target)) {
          return errorResult('add requires target ("memory" | "user" | "workspace").')
        }
        if (typeof input.content !== 'string' || typeof input.importance !== 'string') {
          return errorResult('add requires content and importance (low | medium | high | never_forget).')
        }
        const importance = IMPORTANCE_BY_LABEL[input.importance as ImportanceLabel]
        const result = await session.add({
          scope: TARGET_TO_SCOPE[target], content: input.content, importance,
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
  description: MEMORY_SEARCH_DESCRIPTION,
  shortDescription: 'Find current memory records before updating or removing them',
  deferred: true,
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Required search text. Prefer a short distinctive phrase or specific terms from the expected memory ' +
          'content. Complete phrase matches rank before all-term matches.',
      },
      limit: {
        type: 'number',
        minimum: 1,
        maximum: MEMORY_SEARCH_MAX_LIMIT,
        description: `Maximum number of results to return. Defaults to ${MEMORY_SEARCH_DEFAULT_LIMIT} and is capped at ${MEMORY_SEARCH_MAX_LIMIT}.`,
      },
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
    // PR review (P2): cancellation check before bind (read-only tool, nothing
    // is written — no post-bind re-check needed).
    if (context.abortSignal?.aborted) {
      return errorResult('MemorySearch aborted before it started.')
    }
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
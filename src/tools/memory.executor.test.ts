/**
 * Round-2 review (R2-P1): verify THROUGH THE REAL TOOL EXECUTOR that an
 * unknown storage error surfaces to the model as a FIXED public message —
 * uncaught errors are written verbatim into tool_result by
 * src/engine/tool-executor.ts:599-606, so raw err.message must never escape.
 *
 * Round-3 review (R3-P1): the original error travels ONLY through the
 * diagnostics channel — the capturing sink below asserts the leak arrives
 * there (and nowhere else).
 */

import { describe, expect, it } from 'vitest'
import { executeSingleTool } from '../engine/tool-executor.js'
import type { ToolExecutionContext, ToolUseBlock } from '../engine/tool-executor.js'
import type { DiagnosticsSink } from '../utils/diagnostics.js'
import { createLogger } from '../utils/logger.js'
import { createMemoryService } from '../memory/service.js'
import { InMemoryMemoryStorage } from '../memory/in-memory-storage.js'
import type { ToolContext } from '../types.js'
import { MemoryTool } from './memory.js'

/** Records every diagnostics.error call (message, fields, cause). */
function capturingSink(): { sink: DiagnosticsSink; errors: Array<{ msg: string; cause: unknown }> } {
  const errors: Array<{ msg: string; cause: unknown }> = []
  const sink = {
    debug: () => {},
    trace: () => {},
    warn: () => {},
    error: (msg: string, _fields?: Record<string, unknown>, cause?: unknown) => {
      errors.push({ msg, cause })
    },
    child: () => sink,
  } as DiagnosticsSink
  return { sink, errors }
}

describe('Memory tool through the real executor (R2-P1)', () => {
  it('a leaked storage error becomes a fixed public message; raw text stays off-model', async () => {
    const storage = new InMemoryMemoryStorage()
    // Inject a leaky failure at the storage seam (bind()'s registration path).
    storage.ensureWorkspace = async () => {
      throw new Error('leaked /var/db/memory-state corrupted sk-ant-api03-abcd1234')
    }
    const serviceDiag = capturingSink()
    const service = createMemoryService({ storage, diagnostics: serviceDiag.sink })
    await service.start()

    const ctxDiag = capturingSink()
    const toolContext: ToolContext = {
      cwd: '/repo/a',
      agentId: 'main',
      sessionId: 's1',
      toolUseId: 'tu1',
      services: { memory: service } as unknown as ToolContext['services'],
      subprocessEnv: {},
      diagnostics: ctxDiag.sink,
    }
    // Minimal REAL-executor fixture per ToolExecutionContext (tool-executor.ts:73):
    // logger from createLogger; permissions allow; no hooks.
    const execCtx: ToolExecutionContext = {
      config: {
        runtime: undefined as never,
        resolved: undefined as never,
        subAgents: {},
        canUseTool: async () => ({ behavior: 'allow' }),
        abortSignal: undefined,
        agentId: 'main',
      },
      messages: [],
      sessionId: 's1',
      logger: createLogger('memory-executor-test', { level: 'error' }),
    }
    const block: ToolUseBlock = {
      type: 'tool_use', id: 'tu1', name: 'Memory',
      input: { action: 'add', target: 'memory', content: 'x', importance: 'medium' },
    }
    const result = await executeSingleTool(
      execCtx,
      block,
      MemoryTool,
      toolContext as unknown as Parameters<typeof executeSingleTool>[3],
    )
    expect(result.is_error).toBe(true)
    expect(String(result.content)).toBe('Memory operation failed unexpectedly.')
    expect(String(result.content)).not.toContain('leaked')
    expect(String(result.content)).not.toContain('sk-ant')
    expect(String(result.content)).not.toContain('ensureWorkspace')
    // R3-P1: the raw error IS reported — but only through the diagnostics
    // channel (#78), never into the model-visible tool_result.
    const reported = [...ctxDiag.errors, ...serviceDiag.errors]
    expect(reported.some((e) => e.msg.includes('[memory]'))).toBe(true)
    expect(reported.some((e) => String(e.cause).includes('leaked'))).toBe(true)
    await service.stop()
  })
})
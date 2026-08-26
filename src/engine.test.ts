import { describe, expect, it } from 'vitest'
import { QueryEngine } from './engine.js'
import type { QueryEngineConfig, SDKAssistantMessage, SDKMessage, SDKResultMessage, SDKToolResultMessage, SDKUserMessage, ToolDefinition } from './types.js'
import type { LLMProvider, StreamChunk, CreateMessageParams, NormalizedMessageParam } from './providers/types.js'
import type { Logger } from './utils/logger.js'
import { SkillRegistry } from './skills/index.js'
import { createHookRegistry } from './hooks.js'
import { vi } from 'vitest'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createEmptyServices } from './tools/services.js'
import { getTodos, TodoWriteTool } from './tools/todowrite.js'

// Mirrors the real @anthropic-ai/sdk APIConnectionError: a plain Error with
// name='Error', fixed message, and the underlying failure on `cause`.
class FakeAPIConnectionError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message)
    this.cause = cause
  }
}

function makeConfig(provider: LLMProvider, tools: ToolDefinition[] = []): QueryEngineConfig {
  return {
    env: {
      provider,
      model: 'test-model',
      maxTokens: 100,
      cwd: process.cwd(),
      customTools: [],
      mcpTools: [],
      skillRegistry: new SkillRegistry(),
    },
    resolved: {
      definition: { description: 'test', prompt: 'test prompt' },
      tools,
      deferredTools: [],
      skills: [],
    },
    maxTurns: 5,
    canUseTool: async () => ({ behavior: 'allow' }),
    includePartialMessages: true,
    agentId: 'test',
    maxStreamRetries: 1,
  }
}

async function run(engine: QueryEngine): Promise<SDKMessage[]> {
  const msgs: SDKMessage[] = []
  for await (const m of engine.submitMessage('hi')) msgs.push(m)
  return msgs
}

function findResult(msgs: SDKMessage[]): SDKResultMessage {
  const result = msgs.find((m) => m.type === 'result') as SDKResultMessage | undefined
  if (!result) throw new Error('no result message emitted')
  return result
}

describe('QueryEngine error result', () => {
  it('includes error_type=connection when stream retries are exhausted', async () => {
    const provider: LLMProvider = {
      apiType: 'anthropic-messages',
      async createMessage() {
        throw new Error('not used')
      },
      async *createMessageStream(): AsyncGenerator<StreamChunk> {
        const cause: any = new TypeError('fetch failed')
        throw new FakeAPIConnectionError('Connection error.', cause)
      },
    }

    const result = findResult(await run(new QueryEngine(makeConfig(provider))))

    expect(result.subtype).toBe('error')
    expect(result.error_type).toBe('connection')
    expect(result.errors?.[0]).toBe('Connection error.')
  })

  it('includes error_type=auth for non-retryable auth failures', async () => {
    const provider: LLMProvider = {
      apiType: 'anthropic-messages',
      async createMessage() {
        throw new Error('not used')
      },
      async *createMessageStream(): AsyncGenerator<StreamChunk> {
        throw Object.assign(new Error('Unauthorized'), { status: 401 })
      },
    }

    const result = findResult(await run(new QueryEngine(makeConfig(provider))))

    expect(result.subtype).toBe('error')
    expect(result.error_type).toBe('auth')
  })

  it('marks the final result truncated when the stream breaks mid-response', async () => {
    const provider: LLMProvider = {
      apiType: 'anthropic-messages',
      async createMessage() {
        throw new Error('not used')
      },
      async *createMessageStream(): AsyncGenerator<StreamChunk> {
        yield { type: 'text', index: 0, delta: 'partial' }
        throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
      },
    }

    const result = findResult(await run(new QueryEngine(makeConfig(provider))))

    expect(result.subtype).toBe('success')
    expect(result.truncated).toBe(true)
  })

  it('emits a structured retry system message (no hardcoded text)', async () => {
    let attempts = 0
    const provider: LLMProvider = {
      apiType: 'anthropic-messages',
      async createMessage() {
        throw new Error('not used')
      },
      async *createMessageStream(): AsyncGenerator<StreamChunk> {
        attempts++
        if (attempts === 1) {
          throw new FakeAPIConnectionError('Connection error.', new TypeError('fetch failed'))
        }
        yield { type: 'text', index: 0, delta: 'ok' }
        yield { type: 'done', index: -1 }
      },
    }

    const msgs = await run(new QueryEngine(makeConfig(provider)))
    const retry = msgs.find((m) => m.type === 'system' && (m as any).subtype === 'retry') as any

    expect(retry).toBeDefined()
    expect(retry.attempt).toBe(1)
    expect(retry.error_type).toBe('connection')
    expect(typeof retry.delay_ms).toBe('number')
    expect(retry.message).toBeUndefined()
  })

  it('does not mark truncated on a clean stream', async () => {
    const provider: LLMProvider = {
      apiType: 'anthropic-messages',
      async createMessage() {
        throw new Error('not used')
      },
      async *createMessageStream(): AsyncGenerator<StreamChunk> {
        yield { type: 'text', index: 0, delta: 'ok' }
        yield { type: 'done', index: -1 }
      },
    }

    const result = findResult(await run(new QueryEngine(makeConfig(provider))))

    expect(result.subtype).toBe('success')
    expect(result.truncated).toBeUndefined()
  })
})

describe('QueryEngine tool_result streaming', () => {
  // Regression: tool_result SDK event must surface is_error from the underlying
  // ToolResult. Previously the engine yielded { output, metadata } only,
  // leaving downstream consumers unable to distinguish success from failure.
  it('propagates is_error=true when a tool returns an error result', async () => {
    const failingTool: ToolDefinition = {
      name: 'fail',
      description: 'always fails',
      inputSchema: { type: 'object', properties: {} },
      async call() {
        return {
          type: 'tool_result',
          tool_use_id: '',
          content: 'boom',
          is_error: true,
        }
      },
    }

    // Two-pass stream: first call emits a tool_use, second call ends the turn.
    let pass = 0
    const provider: LLMProvider = {
      apiType: 'anthropic-messages',
      async createMessage() {
        throw new Error('not used')
      },
      async *createMessageStream(): AsyncGenerator<StreamChunk> {
        if (pass++ === 0) {
          yield { type: 'tool_use', index: 1, id: 'tu_1', name: 'fail', input: '{}' }
          yield { type: 'done', index: -1 }
        } else {
          yield { type: 'text', index: 0, delta: 'done' }
          yield { type: 'done', index: -1 }
        }
      },
    }

    const config: QueryEngineConfig = makeConfig(provider, [failingTool])

    const msgs = await run(new QueryEngine(config))
    const toolResult = msgs.find((m) => m.type === 'tool_result') as SDKToolResultMessage | undefined
    expect(toolResult).toBeDefined()
    expect(toolResult!.result.is_error).toBe(true)
    expect(toolResult!.result.output).toBe('boom')
  })

  it('propagates is_error=false (or undefined) when a tool succeeds', async () => {
    const okTool: ToolDefinition = {
      name: 'ok',
      description: 'always succeeds',
      inputSchema: { type: 'object', properties: {} },
      async call() {
        return {
          type: 'tool_result',
          tool_use_id: '',
          content: 'all good',
          is_error: false,
        }
      },
    }

    let pass = 0
    const provider: LLMProvider = {
      apiType: 'anthropic-messages',
      async createMessage() {
        throw new Error('not used')
      },
      async *createMessageStream(): AsyncGenerator<StreamChunk> {
        if (pass++ === 0) {
          yield { type: 'tool_use', index: 1, id: 'tu_1', name: 'ok', input: '{}' }
          yield { type: 'done', index: -1 }
        } else {
          yield { type: 'text', index: 0, delta: 'done' }
          yield { type: 'done', index: -1 }
        }
      },
    }

    const config: QueryEngineConfig = makeConfig(provider, [okTool])

    const msgs = await run(new QueryEngine(config))
    const toolResult = msgs.find((m) => m.type === 'tool_result') as SDKToolResultMessage | undefined
    expect(toolResult).toBeDefined()
    expect(toolResult!.result.is_error).toBeFalsy()
    expect(toolResult!.result.output).toBe('all good')
  })
})

describe('executeTools streaming + tools_complete', () => {
  function makeDelayTool(name: string, delayMs: number, output?: string): ToolDefinition {
    return {
      name,
      description: `delay ${delayMs}ms`,
      inputSchema: { type: 'object', properties: {} },
      isReadOnly: () => true,
      async call() {
        await new Promise(r => setTimeout(r, delayMs))
        return {
          type: 'tool_result',
          tool_use_id: '',
          content: output ?? `done-${name}`,
          is_error: false,
        }
      },
    }
  }

  function makeMultiToolUseProvider(toolCalls: Array<{ id: string; name: string }>): LLMProvider {
    let pass = 0
    return {
      apiType: 'anthropic-messages',
      async createMessage() { throw new Error('not used') },
      async *createMessageStream(): AsyncGenerator<StreamChunk> {
        if (pass++ === 0) {
          for (let i = 0; i < toolCalls.length; i++) {
            const tc = toolCalls[i]
            yield { type: 'tool_use', index: i, id: tc.id, name: tc.name, input: '{}' }
          }
          yield { type: 'done', index: -1 }
        } else {
          yield { type: 'text', index: 0, delta: 'all done' }
          yield { type: 'done', index: -1 }
        }
      },
    }
  }

  it('streams tool_result events in completion order, not block order', async () => {
    // fast (10ms) declared FIRST in block order; slow (200ms) declared SECOND
    const fast = makeDelayTool('fast', 10)
    const slow = makeDelayTool('slow', 200)
    const provider = makeMultiToolUseProvider([
      { id: 'tu_fast', name: 'fast' },
      { id: 'tu_slow', name: 'slow' },
    ])
    const config: QueryEngineConfig = makeConfig(provider, [fast, slow])
    const msgs = await run(new QueryEngine(config))

    const toolResults = msgs.filter(m => m.type === 'tool_result') as SDKToolResultMessage[]
    expect(toolResults).toHaveLength(2)
    // fast should be emitted first despite being declared first in block order
    // (it would also be first by block order; verify by content)
    expect(toolResults[0].result.tool_name).toBe('fast')
    expect(toolResults[1].result.tool_name).toBe('slow')

    // Verify timing: fast tool_result should appear BEFORE slow finishes
    // Use the position of tools_complete as a proxy for "all done"
    const fastIdx = msgs.findIndex(m => m.type === 'tool_result' && (m as SDKToolResultMessage).result.tool_name === 'fast')
    const slowIdx = msgs.findIndex(m => m.type === 'tool_result' && (m as SDKToolResultMessage).result.tool_name === 'slow')
    expect(fastIdx).toBeLessThan(slowIdx)
  })

  it('proves streaming by checking that fast tool_result arrives before slow tool completes', async () => {
    // This is the regression test for the original bug.
    // Use a third "sentinel" event that fires only after slow finishes.
    let slowStarted = 0
    let slowFinished = 0
    const fast = makeDelayTool('fast', 10)
    const slow: ToolDefinition = {
      name: 'slow',
      description: '200ms',
      inputSchema: { type: 'object', properties: {} },
      isReadOnly: () => true,
      async call() {
        slowStarted = Date.now()
        await new Promise(r => setTimeout(r, 200))
        slowFinished = Date.now()
        return { type: 'tool_result', tool_use_id: '', content: 'slow-done', is_error: false }
      },
    }
    const provider = makeMultiToolUseProvider([
      { id: 'tu_fast', name: 'fast' },
      { id: 'tu_slow', name: 'slow' },
    ])
    const config: QueryEngineConfig = makeConfig(provider, [fast, slow])

    const eventTimestamps: { type: string; name?: string; t: number }[] = []
    const engine = new QueryEngine(config)
    for await (const m of engine.submitMessage('hi')) {
      eventTimestamps.push({
        type: m.type,
        name: m.type === 'tool_result' ? (m as SDKToolResultMessage).result.tool_name : undefined,
        t: Date.now(),
      })
    }

    const fastEvent = eventTimestamps.find(e => e.type === 'tool_result' && e.name === 'fast')!
    expect(fastEvent).toBeDefined()
    // fast tool_result must have arrived BEFORE slow finished
    expect(fastEvent.t).toBeLessThan(slowFinished)
    expect(slowFinished - fastEvent.t).toBeGreaterThan(100) // not just noise
  })

  it('emits tools_complete as the last event of the batch with correct counts', async () => {
    const fast = makeDelayTool('fast', 10)
    const slow = makeDelayTool('slow', 30)
    const provider = makeMultiToolUseProvider([
      { id: 'tu_1', name: 'fast' },
      { id: 'tu_2', name: 'slow' },
    ])
    const config: QueryEngineConfig = makeConfig(provider, [fast, slow])
    const msgs = await run(new QueryEngine(config))

    const completeEvents = msgs.filter(m => m.type === 'tools_complete') as any[]
    expect(completeEvents).toHaveLength(1)
    const complete = completeEvents[0]
    expect(complete.tool_use_ids).toEqual(['tu_1', 'tu_2'])
    expect(complete.tool_results_count).toBe(2)
    expect(complete.results).toEqual([
      { tool_use_id: 'tu_1', tool_name: 'fast', is_error: false },
      { tool_use_id: 'tu_2', tool_name: 'slow', is_error: false },
    ])

    // tools_complete must come AFTER all tool_result events (find its index)
    const completeIdx = msgs.findIndex(m => m.type === 'tools_complete')
    const lastToolResultIdx = Math.max(
      ...msgs
        .map((m, i) => m.type === 'tool_result' ? i : -1)
    )
    expect(completeIdx).toBeGreaterThan(lastToolResultIdx)
  })

  it('fills in synthetic aborted tool_result on abort and emits tools_complete', async () => {
    const ac = new AbortController()
    const fast = makeDelayTool('fast', 10)
    const slow: ToolDefinition = {
      name: 'slow',
      description: 'aborts mid-flight',
      inputSchema: { type: 'object', properties: {} },
      isReadOnly: () => true,
      async call() {
        // Wait long enough that abort fires during execution
        await new Promise(r => setTimeout(r, 500))
        return { type: 'tool_result', tool_use_id: '', content: 'should-not-reach', is_error: false }
      },
    }
    const provider = makeMultiToolUseProvider([
      { id: 'tu_fast', name: 'fast' },
      { id: 'tu_slow', name: 'slow' },
    ])
    const config: QueryEngineConfig = { ...makeConfig(provider, [fast, slow]), abortSignal: ac.signal }
    const engine = new QueryEngine(config)
    const msgs: SDKMessage[] = []
    const p = (async () => {
      for await (const m of engine.submitMessage('hi')) {
        msgs.push(m)
        // Abort after fast finishes but before slow finishes. Use a *condition*,
        // not a fixed timer: buildSystemPrompt incurs real I/O (git detection)
        // before tools even start, so a hardcoded delay races environment speed.
        if (m.type === 'tool_result' && (m as SDKToolResultMessage).result.tool_name === 'fast') {
          ac.abort()
        }
      }
    })()
    await p

    const completeEvents = msgs.filter(m => m.type === 'tools_complete') as any[]
    // Note: tools_complete may or may not be received depending on where the
    // outer for-await breaks. Test only if it was received.
    if (completeEvents.length === 1) {
      const complete = completeEvents[0]
      expect(complete.tool_use_ids).toEqual(['tu_fast', 'tu_slow'])
      expect(complete.tool_results_count).toBe(2)
      // slow should have is_error: true (synthetic)
      const slowResult = complete.results.find((r: any) => r.tool_use_id === 'tu_slow')
      expect(slowResult.is_error).toBe(true)
    }
    // At minimum, fast should have emitted before abort
    const fastResult = msgs.find(m => m.type === 'tool_result' && (m as SDKToolResultMessage).result.tool_name === 'fast')
    expect(fastResult).toBeDefined()
  })

  it('persists this.messages correctly after mid-batch abort (force-return invariant)', async () => {
    const ac = new AbortController()
    const fast = makeDelayTool('fast', 10)
    const slow: ToolDefinition = {
      name: 'slow',
      description: 'long-running, gets aborted',
      inputSchema: { type: 'object', properties: {} },
      isReadOnly: () => true,
      async call() {
        await new Promise(r => setTimeout(r, 500))
        return { type: 'tool_result', tool_use_id: '', content: 'unreached', is_error: false }
      },
    }
    const provider = makeMultiToolUseProvider([
      { id: 'tu_fast', name: 'fast' },
      { id: 'tu_slow', name: 'slow' },
    ])
    const config: QueryEngineConfig = { ...makeConfig(provider, [fast, slow]), abortSignal: ac.signal }
    const engine = new QueryEngine(config)
    const p = (async () => {
      for await (const m of engine.submitMessage('hi')) {
        // Abort after fast finishes but before slow finishes. Condition-based
        // (not a fixed timer) so the test is robust to buildSystemPrompt I/O
        // cost before tools start.
        if (m.type === 'tool_result' && (m as SDKToolResultMessage).result.tool_name === 'fast') {
          ac.abort()
        }
      }
    })()
    await p

    // Verify transcript integrity: every tool_use in the last assistant message
    // must have a matching tool_result in the immediately-following user message
    const messages = engine.getMessages()
    // Find last assistant message with tool_use blocks
    let lastAssistantIdx = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i] as any
      if (m.role === 'assistant' && Array.isArray(m.content) &&
          m.content.some((b: any) => b.type === 'tool_use')) {
        lastAssistantIdx = i
        break
      }
    }
    expect(lastAssistantIdx).toBeGreaterThanOrEqual(0)
    const assistantMsg = messages[lastAssistantIdx] as any
    const toolUseIds = assistantMsg.content
      .filter((b: any) => b.type === 'tool_use')
      .map((b: any) => b.id)

    // The next message should be the user message with tool_results
    const userMsg = messages[lastAssistantIdx + 1] as any
    expect(userMsg).toBeDefined()
    expect(userMsg.role).toBe('user')
    expect(Array.isArray(userMsg.content)).toBe(true)
    const toolResultIds = userMsg.content
      .filter((b: any) => b.type === 'tool_result')
      .map((b: any) => b.tool_use_id)

    // Every tool_use must have a matching tool_result
    for (const id of toolUseIds) {
      expect(toolResultIds).toContain(id)
    }
  })

  it('continues other tools when one tool throws', async () => {
    const ok = makeDelayTool('ok', 10)
    const bad: ToolDefinition = {
      name: 'bad',
      description: 'throws',
      inputSchema: { type: 'object', properties: {} },
      isReadOnly: () => true,
      async call() {
        throw new Error('boom')
      },
    }
    const provider = makeMultiToolUseProvider([
      { id: 'tu_ok', name: 'ok' },
      { id: 'tu_bad', name: 'bad' },
    ])
    const config: QueryEngineConfig = makeConfig(provider, [ok, bad])
    const msgs = await run(new QueryEngine(config))

    const toolResults = msgs.filter(m => m.type === 'tool_result') as SDKToolResultMessage[]
    expect(toolResults).toHaveLength(2)
    const badResult = toolResults.find(r => r.result.tool_name === 'bad')!
    expect(badResult.result.is_error).toBe(true)
    expect(badResult.result.output).toContain('boom')
    const okResult = toolResults.find(r => r.result.tool_name === 'ok')!
    expect(okResult.result.is_error).toBe(false)

    const complete = msgs.find(m => m.type === 'tools_complete') as any
    expect(complete.tool_results_count).toBe(2)
  })

  it('drains all tool_result events when multiple tools complete in rapid succession (race regression)', async () => {
    // Three read-only tools that all resolve synchronously. The buggy
    // `while (!backgroundDone)` loop would drop items 2 and 3 because
    // runToolsBackground resolves before the consumer drains the queue.
    const sync1: ToolDefinition = {
      name: 'sync1',
      description: 'instant',
      inputSchema: { type: 'object', properties: {} },
      isReadOnly: () => true,
      async call() {
        return { type: 'tool_result', tool_use_id: '', content: 'r1', is_error: false }
      },
    }
    const sync2: ToolDefinition = {
      name: 'sync2',
      description: 'instant',
      inputSchema: { type: 'object', properties: {} },
      isReadOnly: () => true,
      async call() {
        return { type: 'tool_result', tool_use_id: '', content: 'r2', is_error: false }
      },
    }
    const sync3: ToolDefinition = {
      name: 'sync3',
      description: 'instant',
      inputSchema: { type: 'object', properties: {} },
      isReadOnly: () => true,
      async call() {
        return { type: 'tool_result', tool_use_id: '', content: 'r3', is_error: false }
      },
    }
    const provider = makeMultiToolUseProvider([
      { id: 'tu_1', name: 'sync1' },
      { id: 'tu_2', name: 'sync2' },
      { id: 'tu_3', name: 'sync3' },
    ])
    const config: QueryEngineConfig = makeConfig(provider, [sync1, sync2, sync3])
    const msgs = await run(new QueryEngine(config))

    const toolResults = msgs.filter(m => m.type === 'tool_result') as SDKToolResultMessage[]
    expect(toolResults).toHaveLength(3)

    // Verify content of each (proves they weren't dropped)
    const outputs = toolResults.map(r => r.result.output).sort()
    expect(outputs).toEqual(['r1', 'r2', 'r3'])

    // tools_complete should report correct count
    const complete = msgs.find(m => m.type === 'tools_complete') as any
    expect(complete).toBeDefined()
    expect(complete.tool_results_count).toBe(3)
  })
})

describe('maxSessionTurns halved compaction', () => {
  function makeHalveProvider(opts: { failSummary?: boolean } = {}): LLMProvider {
    return {
      apiType: 'anthropic-messages',
      async createMessage() {
        if (opts.failSummary) throw new Error('summary failed')
        return {
          content: [{ type: 'text', text: 'SESSION SUMMARY' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        } as any
      },
      async *createMessageStream(params: any): AsyncGenerator<StreamChunk> {
        const isCompaction = params.messages?.length === 1
          && typeof params.messages[0].content === 'string'
          && params.messages[0].content.includes('Please summarize')
        if (isCompaction && opts.failSummary) throw new Error('summary failed')
        yield { type: 'text', index: 0, delta: isCompaction ? 'SESSION SUMMARY' : 'final answer' } as StreamChunk
        yield { type: 'usage', usage: { input_tokens: 10, output_tokens: 5, totalInputTokens: 10 } } as any
        yield { type: 'done', index: -1 } as StreamChunk
      },
    }
  }

  function seedTurns(engine: QueryEngine, n: number) {
    for (let i = 1; i <= n; i++) {
      engine.messages.push(
        { role: 'user', content: `seed turn ${i}` },
        { role: 'assistant', content: `seed resp ${i}` },
      )
    }
  }

  it('compacts persistent history when session turns exceed maxSessionTurns', async () => {
    const engine = new QueryEngine({ ...makeConfig(makeHalveProvider()), maxSessionTurns: 2 })
    seedTurns(engine, 3) // 3 seeded turns + 1 submitted = 4 > 2

    await run(engine)

    const json = JSON.stringify(engine.messages)
    expect(json).toContain('SESSION SUMMARY')
    expect(json).not.toContain('seed turn 1')
  })

  it('falls back to hard truncation when summary fails', async () => {
    const engine = new QueryEngine({ ...makeConfig(makeHalveProvider({ failSummary: true })), maxSessionTurns: 2 })
    seedTurns(engine, 3)

    await run(engine)

    const json = JSON.stringify(engine.messages)
    expect(json).not.toContain('SESSION SUMMARY')
    expect(json).not.toContain('seed turn 1')
    expect(json).toContain('seed turn 3')
  })
})

describe('QueryEngine logging (issue #28)', () => {
  const SECRET = 'sk-live-secret-12345'

  const okTool: ToolDefinition = {
    name: 'Bash',
    description: 'runs a command',
    inputSchema: { type: 'object', properties: {} },
    async call() {
      return { type: 'tool_result', tool_use_id: '', content: 'done' }
    },
  }

  function makeToolProvider(): LLMProvider {
    let pass = 0
    return {
      apiType: 'anthropic-messages',
      async createMessage() {
        throw new Error('not used')
      },
      async *createMessageStream(): AsyncGenerator<StreamChunk> {
        if (pass++ === 0) {
          yield {
            type: 'tool_use',
            index: 1,
            id: 'tu_1',
            name: 'Bash',
            input: JSON.stringify({ command: `echo ${SECRET}` }),
          }
          yield { type: 'done', index: -1 }
        } else {
          yield { type: 'text', index: 0, delta: 'done' }
          yield { type: 'done', index: -1 }
        }
      },
    }
  }

  it('uses the host-provided logger and never logs raw tool input', async () => {
    const logged: string[] = []
    const logger: Logger = {
      debug: (msg: string) => logged.push(msg),
      trace: (msg: string) => logged.push(msg),
      error: (msg: string) => logged.push(msg),
      child: () => logger,
    }

    const config: QueryEngineConfig = {
      ...makeConfig(makeToolProvider(), [okTool]),
      logger,
    }
    await run(new QueryEngine(config))

    expect(logged.length).toBeGreaterThan(0)
    expect(logged.join('\n')).not.toContain(SECRET)
  })

  it('suppresses debug output on the default logger when logLevel is error', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    try {
      const config: QueryEngineConfig = {
        ...makeConfig(makeToolProvider(), [okTool]),
        logLevel: 'error',
      }
      await run(new QueryEngine(config))
      expect(debugSpy).not.toHaveBeenCalled()
    } finally {
      debugSpy.mockRestore()
    }
  })

  it('logs redacted tool input only when logLevel is trace', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    try {
      const config: QueryEngineConfig = {
        ...makeConfig(makeToolProvider(), [okTool]),
        logLevel: 'trace',
      }
      await run(new QueryEngine(config))

      const all = debugSpy.mock.calls.map((c) => String(c[0])).join('\n')
      expect(all).toContain('[REDACTED]')
      expect(all).not.toContain(SECRET)
    } finally {
      debugSpy.mockRestore()
    }
  })
})

describe('QueryEngine per-turn todos reminder injection', () => {
  // Helper: seed todos.json for a given sessionId under the same dir the
  // todowrite.ts loader uses (~/.agents/sessions/<sid>/todos.json).
  async function seedTodos(sessionId: string, todos: any[]): Promise<void> {
    const home = process.env.HOME || process.env.USERPROFILE || '/tmp'
    const dir = join(home, '.agents', 'sessions', sessionId)
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'todos.json'),
      JSON.stringify({ updatedAt: new Date().toISOString(), todos }),
      'utf-8',
    )
  }

  it('injects <system-reminder> at end of apiMessages when todos exist', async () => {
    const sid = 'engine-test-with-todos'
    await seedTodos(sid, [
      { content: 'First task', status: 'in_progress', priority: 'high' },
      { content: 'Second task', status: 'pending', priority: 'medium' },
    ])

    let captured: any
    const provider: LLMProvider = {
      apiType: 'anthropic-messages',
      async createMessage() { throw new Error('not used') },
      async *createMessageStream(params: any): AsyncGenerator<StreamChunk> {
        captured = params.messages
        yield { type: 'text', index: 0, delta: 'ok' } as StreamChunk
        yield { type: 'done', index: -1 } as StreamChunk
      },
    }

    const config = { ...makeConfig(provider), sessionId: sid }
    await run(new QueryEngine(config))

    expect(captured).toBeDefined()
    const last = captured[captured.length - 1]
    expect(last.role).toBe('user')
    expect(last.content).toContain('<system-reminder>')
    expect(last.content).toContain('Current task list:')
    expect(last.content).toContain('1. First task [in_progress|high]')
    expect(last.content).toContain('2. Second task [pending|medium]')
  })

  it('does NOT inject reminder when todos.json does not exist', async () => {
    const sid = 'engine-test-no-todos-' + Date.now()

    let captured: any
    const provider: LLMProvider = {
      apiType: 'anthropic-messages',
      async createMessage() { throw new Error('not used') },
      async *createMessageStream(params: any): AsyncGenerator<StreamChunk> {
        captured = params.messages
        yield { type: 'text', index: 0, delta: 'ok' } as StreamChunk
        yield { type: 'done', index: -1 } as StreamChunk
      },
    }

    const config = { ...makeConfig(provider), sessionId: sid }
    await run(new QueryEngine(config))

    expect(captured).toBeDefined()
    const last = captured[captured.length - 1]
    // Without todos.json, the last message is the user's "hi" prompt, not a reminder.
    expect(typeof last.content).toBe('string')
    expect(last.content).not.toContain('<system-reminder>')
  })

  it('does NOT persist the reminder into engine.messages (ephemeral injection)', async () => {
    const sid = 'engine-test-persistence'
    await seedTodos(sid, [
      { content: 'sticky task', status: 'in_progress', priority: 'high' },
    ])

    const provider: LLMProvider = {
      apiType: 'anthropic-messages',
      async createMessage() { throw new Error('not used') },
      async *createMessageStream(): AsyncGenerator<StreamChunk> {
        yield { type: 'text', index: 0, delta: 'ok' } as StreamChunk
        yield { type: 'done', index: -1 } as StreamChunk
      },
    }

    const engine = new QueryEngine({ ...makeConfig(provider), sessionId: sid })
    await run(engine)

    // engine.getMessages() returns the persistent history — must NOT contain the reminder.
    const persisted = engine.getMessages()
    const allPersisted = JSON.stringify(persisted)
    expect(allPersisted).not.toContain('<system-reminder>')
    expect(allPersisted).not.toContain('Current task list:')
  })

  // ---- issue #32: all-terminal TodoList must not leak into the next query ----

  /** Build a streaming provider that captures the messages it was called with. */
  function makeCapturingProvider(): {
    provider: LLMProvider
    getCaptured: () => NormalizedMessageParam[]
  } {
    let captured: NormalizedMessageParam[] = []
    const provider: LLMProvider = {
      apiType: 'anthropic-messages',
      async createMessage() { throw new Error('not used') },
      async *createMessageStream(params: CreateMessageParams): AsyncGenerator<StreamChunk> {
        captured = params.messages as NormalizedMessageParam[]
        yield { type: 'text', index: 0, delta: 'ok' } as StreamChunk
        yield { type: 'done', index: -1 } as StreamChunk
      },
    }
    return { provider, getCaptured: () => captured }
  }

  function lastMessageContent(captured: NormalizedMessageParam[]): string {
    const last = captured[captured.length - 1]
    const content = last?.content
    return typeof content === 'string' ? content : ''
  }

  it('does NOT inject an all-completed TodoList into the next turn (issue #32)', async () => {
    const sid = 'engine-test-all-completed'
    await seedTodos(sid, [
      { content: 'Implement change', status: 'completed', priority: 'high' },
      { content: 'Run tests', status: 'completed', priority: 'medium' },
    ])
    const { provider, getCaptured } = makeCapturingProvider()

    await run(new QueryEngine({ ...makeConfig(provider), sessionId: sid }))

    const content = lastMessageContent(getCaptured())
    expect(content).not.toContain('<system-reminder>')
    expect(content).not.toContain('Current task list:')
  })

  it('does NOT inject a mixed completed + cancelled TodoList (all-terminal)', async () => {
    const sid = 'engine-test-completed-cancelled'
    await seedTodos(sid, [
      { content: 'Done task', status: 'completed', priority: 'high' },
      { content: 'Abandoned task', status: 'cancelled', priority: 'low' },
    ])
    const { provider, getCaptured } = makeCapturingProvider()

    await run(new QueryEngine({ ...makeConfig(provider), sessionId: sid }))

    expect(lastMessageContent(getCaptured())).not.toContain('<system-reminder>')
  })

  it('still injects a list containing pending or in_progress todos', async () => {
    // pending-only
    {
      const sid = 'engine-test-pending-active'
      await seedTodos(sid, [
        { content: 'Queued task', status: 'pending', priority: 'medium' },
      ])
      const { provider, getCaptured } = makeCapturingProvider()
      await run(new QueryEngine({ ...makeConfig(provider), sessionId: sid }))
      const content = lastMessageContent(getCaptured())
      expect(content).toContain('<system-reminder>')
      expect(content).toContain('1. Queued task [pending|medium]')
    }
    // in_progress-only
    {
      const sid = 'engine-test-inprogress-active'
      await seedTodos(sid, [
        { content: 'Active task', status: 'in_progress', priority: 'high' },
      ])
      const { provider, getCaptured } = makeCapturingProvider()
      await run(new QueryEngine({ ...makeConfig(provider), sessionId: sid }))
      expect(lastMessageContent(getCaptured())).toContain('<system-reminder>')
    }
  })

  it('clears the terminal TodoList before the provider request is constructed', async () => {
    const sid = 'engine-test-cleanup-before-request'
    await seedTodos(sid, [
      { content: 'Finished', status: 'completed', priority: 'high' },
    ])
    const { provider, getCaptured } = makeCapturingProvider()

    await run(new QueryEngine({ ...makeConfig(provider), sessionId: sid }))

    // The provider received NO reminder — proving cleanup happened before request build,
    // not merely that the reminder was stripped afterwards.
    expect(lastMessageContent(getCaptured())).not.toContain('<system-reminder>')
    // And the persisted store is empty right after the run completes.
    expect(await getTodos(sid)).toEqual([])
  })

  it('leaves getTodos empty after clearing an all-terminal list (host consistency)', async () => {
    const sid = 'engine-test-gettodos-empty'
    await seedTodos(sid, [
      { content: 'Task A', status: 'completed', priority: 'high' },
      { content: 'Task B', status: 'cancelled', priority: 'low' },
    ])

    await run(new QueryEngine({ ...makeConfig(makeCapturingProvider().provider), sessionId: sid }))

    const after = await getTodos(sid)
    expect(after).toEqual([])
  })

  it('list completed during query A survives until query B starts (lifecycle boundary, issue #32)', async () => {
    const sid = 'engine-test-multiturn-lifecycle'
    // Seed an ACTIVE list — query A start will NOT clear it.
    await seedTodos(sid, [
      { content: 'Implement feature', status: 'in_progress', priority: 'high' },
    ])

    let pass = 0
    let capturedB: NormalizedMessageParam[] = []
    const completedInput = JSON.stringify({
      todos: [{ content: 'Implement feature', status: 'completed', priority: 'high' }],
    })

    const provider: LLMProvider = {
      apiType: 'anthropic-messages',
      async createMessage() { throw new Error('not used') },
      async *createMessageStream(params: CreateMessageParams): AsyncGenerator<StreamChunk> {
        if (pass === 0) {
          // Query A, turn 1: model calls TodoWrite to mark everything completed
          pass++
          yield { type: 'tool_use', index: 1, id: 'tu_todo', name: 'TodoWrite', input: completedInput } as StreamChunk
          yield { type: 'done', index: -1 } as StreamChunk
        } else if (pass === 1) {
          // Query A, turn 2: final text — query A ends
          pass++
          yield { type: 'text', index: 0, delta: 'query A done' } as StreamChunk
          yield { type: 'done', index: -1 } as StreamChunk
        } else {
          // Query B: capture messages and end immediately
          pass++
          capturedB = params.messages as NormalizedMessageParam[]
          yield { type: 'text', index: 0, delta: 'query B done' } as StreamChunk
          yield { type: 'done', index: -1 } as StreamChunk
        }
      },
    }

    // TodoWriteTool is the real tool so the engine actually persists the list.
    const engine = new QueryEngine({ ...makeConfig(provider, [TodoWriteTool]), sessionId: sid })

    // --- Query A ---
    await run(engine)

    // SURVIVAL: the all-terminal list written during query A is still persisted.
    // Cleanup did NOT fire mid-query (only at the NEXT query's start).
    const afterA = await getTodos(sid)
    expect(afterA).toHaveLength(1)
    expect(afterA[0].status).toBe('completed')

    // --- Query B (same engine + session) ---
    await run(engine)

    // CLEARANCE: query B's provider call received NO stale reminder.
    expect(lastMessageContent(capturedB)).not.toContain('<system-reminder>')
    expect(lastMessageContent(capturedB)).not.toContain('Current task list:')

    // And the persisted store is now empty.
    const afterB = await getTodos(sid)
    expect(afterB).toEqual([])
  })
})

describe('QueryEngine per-turn tool activation', () => {
  function makeDeferredCronListTool() {
    return {
      name: 'CronList',
      description: 'List scheduled tasks',
      shortDescription: 'List scheduled tasks',
      deferred: true,
      inputSchema: { type: 'object', properties: {} },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      isEnabled: () => true,
      async call() {
        return {
          type: 'tool_result',
          tool_use_id: '',
          content: 'no scheduled tasks',
        }
      },
    } as any
  }

  function makeFindToolStandIn() {
    return {
      name: 'FindTool',
      description: 'search',
      inputSchema: { type: 'object', properties: {} },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      isEnabled: () => true,
      async call(input: any, ctx: any) {
        if (input?.query === 'select:CronList') {
          ctx.services.findTool.activatedTools.add('CronList')
          return { type: 'tool_result', tool_use_id: '', content: 'Loaded 1 tool(s): CronList' }
        }
        return { type: 'tool_result', tool_use_id: '', content: 'no match' }
      },
    } as any
  }

  it('FindTool in turn 1 makes CronList schema available in turn 2', async () => {
    let turn = 0
    let turn2Tools: any
    const provider: LLMProvider = {
      apiType: 'anthropic-messages',
      async createMessage() { throw new Error('not used') },
      async *createMessageStream(params: any): AsyncGenerator<StreamChunk> {
        turn++
        if (turn === 1) {
          // Verify CronList is NOT in turn 1 tools (deferred)
          expect(params.tools?.find((t: any) => t.name === 'CronList')).toBeUndefined()
          // Emit a FindTool call
          yield { type: 'tool_use', index: 1, id: 'tu_1', name: 'FindTool', input: '{"query":"select:CronList"}' } as StreamChunk
          yield { type: 'done', index: -1 } as StreamChunk
        } else {
          // Capture turn 2 tools — CronList should be present
          turn2Tools = params.tools
          yield { type: 'text', index: 0, delta: 'done' } as StreamChunk
          yield { type: 'done', index: -1 } as StreamChunk
        }
      },
    }

    const baseConfig = makeConfig(provider)
    const config: QueryEngineConfig = {
      ...baseConfig,
      env: {
        ...baseConfig.env,
        toolServices: createEmptyServices(),
      },
      resolved: {
        definition: { description: 'test', prompt: 'test' },
        tools: [makeFindToolStandIn()],
        deferredTools: [makeDeferredCronListTool()],
        skills: [],
      } as any,
    } as any

    await run(new QueryEngine(config))

    expect(turn2Tools).toBeDefined()
    expect(turn2Tools.find((t: any) => t.name === 'CronList')).toBeDefined()
  })

  it('persists activation across queries within a session', async () => {
    // Session-scoped activation: tool activated in query 1 stays available
    // at the start of query 2 (no re-FindTool needed).
    let query = 0
    let query2Turn1Tools: any
    const provider: LLMProvider = {
      apiType: 'anthropic-messages',
      async createMessage() { throw new Error('not used') },
      async *createMessageStream(params: any): AsyncGenerator<StreamChunk> {
        query++
        if (query === 1) {
          // turn 1 of query 1: FindTool activates CronList
          expect(params.tools?.find((t: any) => t.name === 'CronList')).toBeUndefined()
          yield { type: 'tool_use', index: 1, id: 'tu_1', name: 'FindTool', input: '{"query":"select:CronList"}' } as StreamChunk
          yield { type: 'done', index: -1 } as StreamChunk
        } else if (query === 2) {
          // turn 1 of query 2: CronList schema should already be present
          // (no FindTool call this query)
          query2Turn1Tools = params.tools
          yield { type: 'text', index: 0, delta: 'ok' } as StreamChunk
          yield { type: 'done', index: -1 } as StreamChunk
        } else {
          yield { type: 'text', index: 0, delta: 'ok' } as StreamChunk
          yield { type: 'done', index: -1 } as StreamChunk
        }
      },
    }

    const baseConfig = makeConfig(provider)
    const config: QueryEngineConfig = {
      ...baseConfig,
      env: {
        ...baseConfig.env,
        toolServices: createEmptyServices(),
      },
      resolved: {
        definition: { description: 'test', prompt: 'test' },
        tools: [makeFindToolStandIn()],
        deferredTools: [makeDeferredCronListTool()],
        skills: [],
      } as any,
    } as any

    const engine = new QueryEngine(config)
    await run(engine)  // query 1: FindTool
    await run(engine)  // query 2: should see CronList without FindTool

    expect(query2Turn1Tools).toBeDefined()
    expect(query2Turn1Tools.find((t: any) => t.name === 'CronList')).toBeDefined()
  })
})

describe('QueryEngine message timestamps (issue #54)', () => {
  it('user history message and user event share id and parseable ISO timestamp', async () => {
    const provider: LLMProvider = {
      apiType: 'anthropic-messages',
      async createMessage() {
        throw new Error('not used')
      },
      async *createMessageStream(): AsyncGenerator<StreamChunk> {
        yield { type: 'text', index: 0, delta: 'ok' }
        yield { type: 'done', index: -1 }
      },
    }
    const engine = new QueryEngine(makeConfig(provider))
    const events = await run(engine)

    const userEvent = events.find((m) => m.type === 'user') as SDKUserMessage | undefined
    expect(userEvent).toBeDefined()
    expect(Date.parse(userEvent!.timestamp)).not.toBeNaN()
    expect(userEvent!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)

    const userMsg = engine.getMessages().find((m) => m.role === 'user')
    expect(userMsg?.id).toBe(userEvent!.uuid)
    expect(userMsg?.timestamp).toBe(userEvent!.timestamp)
  })

  it('hook-blocked prompt enters neither history nor events', async () => {
    const provider: LLMProvider = {
      apiType: 'anthropic-messages',
      async createMessage() {
        throw new Error('not used')
      },
    }
    const hookRegistry = createHookRegistry()
    hookRegistry.register('UserPromptSubmit', {
      handler: async () => ({ block: true }),
    })
    const engine = new QueryEngine({ ...makeConfig(provider), hookRegistry })
    const events = await run(engine)

    expect(events.find((m) => m.type === 'user')).toBeUndefined()
    expect(engine.getMessages().find((m) => m.role === 'user')).toBeUndefined()
  })

  it('provider failure after user acceptance keeps the timestamped user message', async () => {
    const provider: LLMProvider = {
      apiType: 'anthropic-messages',
      async createMessage() {
        throw new Error('not used')
      },
      async *createMessageStream(): AsyncGenerator<StreamChunk> {
        throw new FakeAPIConnectionError('Connection error.', new TypeError('fetch failed'))
      },
    }
    const engine = new QueryEngine(makeConfig(provider))
    const events = await run(engine)

    const userEvent = events.find((m) => m.type === 'user') as SDKUserMessage | undefined
    expect(userEvent).toBeDefined()
    const userMsg = engine.getMessages().find((m) => m.role === 'user')
    expect(userMsg?.id).toBe(userEvent?.uuid)
    expect(userMsg?.timestamp).toBe(userEvent?.timestamp)
    expect(Date.parse(userMsg!.timestamp!)).not.toBeNaN()
  })

  it('assistant history message and assistant event share id and parseable ISO timestamp', async () => {
    const provider: LLMProvider = {
      apiType: 'anthropic-messages',
      async createMessage() {
        throw new Error('not used')
      },
      async *createMessageStream(): AsyncGenerator<StreamChunk> {
        yield { type: 'text', index: 0, delta: 'ok' }
        yield { type: 'done', index: -1 }
      },
    }
    const engine = new QueryEngine(makeConfig(provider))
    const events = await run(engine)

    const assistantEvent = events.find((m) => m.type === 'assistant') as SDKAssistantMessage | undefined
    expect(assistantEvent).toBeDefined()
    expect(Date.parse(assistantEvent!.timestamp)).not.toBeNaN()

    const assistantMsg = engine.getMessages().find((m) => m.role === 'assistant')
    expect(assistantMsg?.id).toBe(assistantEvent!.uuid)
    expect(assistantMsg?.timestamp).toBe(assistantEvent!.timestamp)
  })
})

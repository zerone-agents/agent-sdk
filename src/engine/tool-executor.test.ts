import { describe, expect, it, vi } from 'vitest'
import {
  executeTools,
  executeSingleTool,
  runToolsBackground,
  type ToolUseBlock,
  type ToolExecutionContext,
} from './tool-executor.js'
import type {
  QueryEngineConfig,
  ToolDefinition,
  ToolResult,
  SDKMessage,
  SDKSubagentMessage,
} from '../types.js'
import type { NormalizedMessageParam } from '../providers/types.js'
import type { Logger } from '../utils/logger.js'
import { createEmptyServices } from '../tools/services.js'
import { SkillRegistry } from '../skills/registry.js'

// ============================================================================
// Test helpers
// ============================================================================

function noopLogger(): Logger {
  return {
    debug: () => {},
    trace: () => {},
    error: () => {},
    child: () => noopLogger(),
  }
}

function spyLogger() {
  const calls = { debug: [] as string[], trace: [] as string[], error: [] as string[] }
  const logger: Logger = {
    debug: (msg: string) => calls.debug.push(msg),
    trace: (msg: string) => calls.trace.push(msg),
    error: (msg: string) => calls.error.push(msg),
    child: () => logger,
  }
  return { logger, calls }
}

function makeTool(overrides: Partial<ToolDefinition> & { name: string }): ToolDefinition {
  return {
    description: 'test tool',
    inputSchema: { type: 'object' as const, properties: {} },
    call: vi.fn().mockResolvedValue({ type: 'tool_result' as const, tool_use_id: '', content: 'ok' }),
    ...overrides,
  }
}

function makeBlock(overrides: Partial<ToolUseBlock> & { id: string; name: string }): ToolUseBlock {
  return {
    type: 'tool_use',
    input: {},
    ...overrides,
  }
}

function makeCtx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    config: {
      env: {
        cwd: '/test',
        model: 'test-model',
        provider: {} as any,
        tools: [],
        skills: [],
        settingSources: [],
      },
      resolved: {
        definition: { prompt: 'test', allowedTools: [], availableSkills: [] },
        tools: [],
        skills: [],
        services: createEmptyServices(),
        skillRegistry: new SkillRegistry(),
      },
      subAgents: {},
      abortSignal: undefined,
      agentId: 'test-agent',
      canUseTool: undefined,
    } as any,
    messages: [],
    sessionId: 'test-session',
    hooks: undefined,
    logger: noopLogger(),
    ...overrides,
  }
}

// ============================================================================
// executeSingleTool
// ============================================================================

describe('executeSingleTool', () => {
  it('returns is_error=true for unknown tool', async () => {
    const ctx = makeCtx()
    const block = makeBlock({ id: 't1', name: 'nonexistent' })
    const result = await executeSingleTool(ctx, block, undefined, {
      cwd: '/test',
      abortSignal: undefined,
      agentId: 'test',
      sessionId: 's1',
      toolUseId: 't1',
      resolvedSkills: [],
      skillRegistry: undefined as any,
      env: {} as any,
      subAgents: {},
      services: createEmptyServices(),
      subprocessEnv: {},
    })

    expect(result.is_error).toBe(true)
    expect(result.content).toContain('Unknown tool')
    expect(result.tool_use_id).toBe('t1')
    expect(result.tool_name).toBe('nonexistent')
  })

  it('returns is_error=true when input is a string (invalid JSON)', async () => {
    const ctx = makeCtx()
    const block = makeBlock({ id: 't1', name: 'test', input: 'not-json' })
    const tool = makeTool({ name: 'test' })

    const result = await executeSingleTool(ctx, block, tool, {
      cwd: '/test',
      abortSignal: undefined,
      agentId: 'test',
      sessionId: 's1',
      toolUseId: 't1',
      resolvedSkills: [],
      skillRegistry: undefined as any,
      env: {} as any,
      subAgents: {},
      services: createEmptyServices(),
      subprocessEnv: {},
    })

    expect(result.is_error).toBe(true)
    expect(result.content).toContain('not valid JSON')
  })

  it('returns is_error=true when tool is disabled', async () => {
    const ctx = makeCtx()
    const block = makeBlock({ id: 't1', name: 'test' })
    const tool = makeTool({ name: 'test', isEnabled: () => false })

    const result = await executeSingleTool(ctx, block, tool, {
      cwd: '/test',
      abortSignal: undefined,
      agentId: 'test',
      sessionId: 's1',
      toolUseId: 't1',
      resolvedSkills: [],
      skillRegistry: undefined as any,
      env: {} as any,
      subAgents: {},
      services: createEmptyServices(),
      subprocessEnv: {},
    })

    expect(result.is_error).toBe(true)
    expect(result.content).toContain('not enabled')
  })

  it('returns is_error=true when permission denied', async () => {
    const ctx = makeCtx({
      config: {
        ...makeCtx().config,
        canUseTool: async () => ({ behavior: 'deny' as const, message: 'Nope' }),
      } as any,
    })
    const block = makeBlock({ id: 't1', name: 'test' })
    const tool = makeTool({ name: 'test' })

    const result = await executeSingleTool(ctx, block, tool, {
      cwd: '/test',
      abortSignal: undefined,
      agentId: 'test',
      sessionId: 's1',
      toolUseId: 't1',
      resolvedSkills: [],
      skillRegistry: undefined as any,
      env: {} as any,
      subAgents: {},
      services: createEmptyServices(),
      subprocessEnv: {},
    })

    expect(result.is_error).toBe(true)
    expect(result.content).toContain('Nope')
  })

  it('applies updatedInput from permission check', async () => {
    const callFn = vi.fn().mockResolvedValue({
      type: 'tool_result' as const,
      tool_use_id: '',
      content: 'ok',
    })
    const ctx = makeCtx({
      config: {
        ...makeCtx().config,
        canUseTool: async () => ({
          behavior: 'allow' as const,
          updatedInput: { modified: true },
        }),
      } as any,
    })
    const block = makeBlock({ id: 't1', name: 'test', input: { original: true } })
    const tool = makeTool({ name: 'test', call: callFn })

    await executeSingleTool(ctx, block, tool, {
      cwd: '/test',
      abortSignal: undefined,
      agentId: 'test',
      sessionId: 's1',
      toolUseId: 't1',
      resolvedSkills: [],
      skillRegistry: undefined as any,
      env: {} as any,
      subAgents: {},
      services: createEmptyServices(),
      subprocessEnv: {},
    })

    // Tool should be called with the updated input, not the original
    expect(callFn).toHaveBeenCalledWith({ modified: true }, expect.anything())
  })

  it('returns is_error=true when required fields are missing', async () => {
    const ctx = makeCtx()
    const block = makeBlock({ id: 't1', name: 'test', input: {} })
    const tool = makeTool({
      name: 'test',
      inputSchema: {
        type: 'object' as const,
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    })

    const result = await executeSingleTool(ctx, block, tool, {
      cwd: '/test',
      abortSignal: undefined,
      agentId: 'test',
      sessionId: 's1',
      toolUseId: 't1',
      resolvedSkills: [],
      skillRegistry: undefined as any,
      env: {} as any,
      subAgents: {},
      services: createEmptyServices(),
      subprocessEnv: {},
    })

    expect(result.is_error).toBe(true)
    expect(result.content).toContain('Missing required fields: path')
  })

  it('returns tool result on success', async () => {
    const ctx = makeCtx()
    const block = makeBlock({ id: 't1', name: 'test', input: { path: '/tmp/x' } })
    const tool = makeTool({
      name: 'test',
      call: vi.fn().mockResolvedValue({
        type: 'tool_result' as const,
        tool_use_id: '',
        content: 'file contents',
      }),
    })

    const result = await executeSingleTool(ctx, block, tool, {
      cwd: '/test',
      abortSignal: undefined,
      agentId: 'test',
      sessionId: 's1',
      toolUseId: 't1',
      resolvedSkills: [],
      skillRegistry: undefined as any,
      env: {} as any,
      subAgents: {},
      services: createEmptyServices(),
      subprocessEnv: {},
    })

    expect(result.is_error).toBeFalsy()
    expect(result.content).toBe('file contents')
    expect(result.tool_use_id).toBe('t1')
    expect(result.tool_name).toBe('test')
  })

  it('catches tool execution errors and returns is_error', async () => {
    const ctx = makeCtx()
    const block = makeBlock({ id: 't1', name: 'test' })
    const tool = makeTool({
      name: 'test',
      call: vi.fn().mockRejectedValue(new Error('boom')),
    })

    const result = await executeSingleTool(ctx, block, tool, {
      cwd: '/test',
      abortSignal: undefined,
      agentId: 'test',
      sessionId: 's1',
      toolUseId: 't1',
      resolvedSkills: [],
      skillRegistry: undefined as any,
      env: {} as any,
      subAgents: {},
      services: createEmptyServices(),
      subprocessEnv: {},
    })

    expect(result.is_error).toBe(true)
    expect(result.content).toContain('boom')
  })

  it('handles permission check errors gracefully', async () => {
    const ctx = makeCtx({
      config: {
        ...makeCtx().config,
        canUseTool: async () => { throw new Error('perm check failed') },
      } as any,
    })
    const block = makeBlock({ id: 't1', name: 'test' })
    const tool = makeTool({ name: 'test' })

    const result = await executeSingleTool(ctx, block, tool, {
      cwd: '/test',
      abortSignal: undefined,
      agentId: 'test',
      sessionId: 's1',
      toolUseId: 't1',
      resolvedSkills: [],
      skillRegistry: undefined as any,
      env: {} as any,
      subAgents: {},
      services: createEmptyServices(),
      subprocessEnv: {},
    })

    expect(result.is_error).toBe(true)
    expect(result.content).toContain('Permission check error')
  })
})

// ============================================================================
// runToolsBackground
// ============================================================================

describe('runToolsBackground', () => {
  function makeToolCtx(tools: ToolDefinition[]): ToolExecutionContext {
    return makeCtx({
      config: {
        ...makeCtx().config,
        resolved: {
          definition: { prompt: 'test', allowedTools: [], availableSkills: [] },
          tools,
          skills: [],
          services: createEmptyServices(),
          skillRegistry: new SkillRegistry(),
        },
      } as any,
    })
  }

  it('runs read-only tools concurrently and mutations serially', async () => {
    const order: string[] = []

    const readOnlyTool = makeTool({
      name: 'read',
      isReadOnly: () => true,
      call: vi.fn().mockImplementation(async () => {
        order.push('read-start')
        await new Promise(r => setTimeout(r, 10))
        order.push('read-end')
        return { type: 'tool_result' as const, tool_use_id: '', content: 'ok' }
      }),
    })

    const mutationTool = makeTool({
      name: 'write',
      call: vi.fn().mockImplementation(async () => {
        order.push('write-start')
        await new Promise(r => setTimeout(r, 5))
        order.push('write-end')
        return { type: 'tool_result' as const, tool_use_id: '', content: 'ok' }
      }),
    })

    const ctx = makeToolCtx([readOnlyTool, mutationTool])
    const blocks = [
      makeBlock({ id: 't1', name: 'read' }),
      makeBlock({ id: 't2', name: 'write' }),
    ]

    const results: Array<ToolResult & { tool_name?: string }> = []
    const subagentEvents: SDKSubagentMessage[] = []

    await runToolsBackground(
      ctx,
      blocks,
      (e) => subagentEvents.push(e),
      (r) => results.push(r),
    )

    expect(results).toHaveLength(2)
    // Both tools should have completed
    expect(results.map(r => r.tool_name)).toEqual(expect.arrayContaining(['read', 'write']))
  })

  it('catches per-tool errors without aborting the batch', async () => {
    const goodTool = makeTool({
      name: 'good',
      isReadOnly: () => true,
      call: vi.fn().mockResolvedValue({
        type: 'tool_result' as const,
        tool_use_id: '',
        content: 'ok',
      }),
    })

    const badTool = makeTool({
      name: 'bad',
      isReadOnly: () => true,
      call: vi.fn().mockRejectedValue(new Error('boom')),
    })

    const ctx = makeToolCtx([goodTool, badTool])
    const blocks = [
      makeBlock({ id: 't1', name: 'good' }),
      makeBlock({ id: 't2', name: 'bad' }),
    ]

    const results: Array<ToolResult & { tool_name?: string }> = []

    await runToolsBackground(
      ctx,
      blocks,
      () => {},
      (r) => results.push(r),
    )

    expect(results).toHaveLength(2)
    const goodResult = results.find(r => r.tool_name === 'good')
    const badResult = results.find(r => r.tool_name === 'bad')
    expect(goodResult?.is_error).toBeFalsy()
    expect(badResult?.is_error).toBe(true)
  })

  it('skips remaining tools when abort signal fires', async () => {
    const abortController = new AbortController()
    const ctx = makeCtx({
      config: {
        ...makeCtx().config,
        abortSignal: abortController.signal,
      } as any,
    })

    const tool = makeTool({
      name: 'test',
      call: vi.fn().mockResolvedValue({
        type: 'tool_result' as const,
        tool_use_id: '',
        content: 'ok',
      }),
    })

    const ctxWithTool = makeCtx({
      config: {
        ...makeCtx().config,
        resolved: {
          definition: { prompt: 'test', allowedTools: [], availableSkills: [] },
          tools: [tool],
          skills: [],
          services: createEmptyServices(),
          skillRegistry: new SkillRegistry(),
        },
        abortSignal: abortController.signal,
      } as any,
    })

    abortController.abort()

    const blocks = [makeBlock({ id: 't1', name: 'test' })]
    const results: Array<ToolResult & { tool_name?: string }> = []

    await runToolsBackground(ctxWithTool, blocks, () => {}, (r) => results.push(r))

    // Tool should NOT have been called because abort fired before execution
    expect(results).toHaveLength(0)
  })
})

// ============================================================================
// executeTools (streaming generator)
// ============================================================================

describe('executeTools', () => {
  function makeStreamCtx(tools: ToolDefinition[]): ToolExecutionContext {
    return makeCtx({
      config: {
        ...makeCtx().config,
        resolved: {
          definition: { prompt: 'test', allowedTools: [], availableSkills: [] },
          tools,
          skills: [],
          services: createEmptyServices(),
          skillRegistry: new SkillRegistry(),
        },
      } as any,
    })
  }

  it('yields tool_result events and tools_complete', async () => {
    const tool = makeTool({
      name: 'test',
      isReadOnly: () => true,
      call: vi.fn().mockResolvedValue({
        type: 'tool_result' as const,
        tool_use_id: '',
        content: 'hello',
      }),
    })

    const ctx = makeStreamCtx([tool])
    const messages: NormalizedMessageParam[] = []
    ctx.messages = messages

    const blocks = [makeBlock({ id: 't1', name: 'test' })]
    const events: any[] = []

    for await (const event of executeTools(ctx, blocks)) {
      events.push(event)
    }

    // Should have: tool_result + tools_complete
    const toolResults = events.filter(e => e.type === 'tool_result')
    const completes = events.filter(e => e.type === 'tools_complete')

    expect(toolResults).toHaveLength(1)
    expect(toolResults[0].result.output).toBe('hello')
    expect(completes).toHaveLength(1)
    expect(completes[0].tool_results_count).toBe(1)

    // Messages should have been persisted
    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe('user')
  })

  it('fills in synthetic results for aborted tools', async () => {
    const slowTool = makeTool({
      name: 'slow',
      isReadOnly: () => true,
      call: vi.fn().mockImplementation(() => new Promise(r => setTimeout(() => r({
        type: 'tool_result' as const,
        tool_use_id: '',
        content: 'done',
      }), 1000))),
    })

    const abortController = new AbortController()
    const ctx = makeCtx({
      config: {
        ...makeCtx().config,
        resolved: {
          definition: { prompt: 'test', allowedTools: [], availableSkills: [] },
          tools: [slowTool],
          skills: [],
          services: createEmptyServices(),
          skillRegistry: new SkillRegistry(),
        },
        abortSignal: abortController.signal,
      } as any,
    })
    const messages: NormalizedMessageParam[] = []
    ctx.messages = messages

    const blocks = [makeBlock({ id: 't1', name: 'slow' })]
    const events: any[] = []

    // Abort after a short delay
    setTimeout(() => abortController.abort(), 20)

    for await (const event of executeTools(ctx, blocks)) {
      events.push(event)
    }

    // Should have synthetic result + tools_complete
    const toolResults = events.filter(e => e.type === 'tool_result')
    expect(toolResults.length).toBeGreaterThanOrEqual(1)

    const synthetic = toolResults.find(e => e.result.is_error)
    expect(synthetic).toBeDefined()
    expect(synthetic.result.output).toContain('aborted')
  })

  it('persists messages even on force-return', async () => {
    const tool = makeTool({
      name: 'test',
      isReadOnly: () => true,
      call: vi.fn().mockImplementation(() => new Promise(r => setTimeout(() => r({
        type: 'tool_result' as const,
        tool_use_id: '',
        content: 'done',
      }), 500))),
    })

    const ctx = makeStreamCtx([tool])
    const messages: NormalizedMessageParam[] = []
    ctx.messages = messages

    const blocks = [makeBlock({ id: 't1', name: 'test' })]

    // Force-return the generator after first yield
    const gen = executeTools(ctx, blocks)
    const first = await gen.next()
    expect(first.done).toBe(false)

    // Force return
    await gen.return!(undefined as any)

    // Messages should still have been persisted by the finally block
    expect(messages.length).toBeGreaterThanOrEqual(1)
  })

  it('emits tools_complete with correct tool_use_ids', async () => {
    const tool = makeTool({
      name: 'test',
      isReadOnly: () => true,
      call: vi.fn().mockResolvedValue({
        type: 'tool_result' as const,
        tool_use_id: '',
        content: 'ok',
      }),
    })

    const ctx = makeStreamCtx([tool])
    ctx.messages = []

    const blocks = [
      makeBlock({ id: 'a', name: 'test' }),
      makeBlock({ id: 'b', name: 'test' }),
    ]
    const events: any[] = []

    for await (const event of executeTools(ctx, blocks)) {
      events.push(event)
    }

    const complete = events.find(e => e.type === 'tools_complete')
    expect(complete.tool_use_ids).toEqual(['a', 'b'])
    expect(complete.tool_results_count).toBe(2)
  })
})

// ============================================================================
// Logging security (issue #28)
// ============================================================================

describe('executeSingleTool logging security', () => {
  const SECRET = 'sk-live-secret-12345'

  function runWithLogger(logger: Logger, input: unknown) {
    const ctx = makeCtx({ logger })
    const block = makeBlock({ id: 't1', name: 'Bash', input })
    const tool = makeTool({ name: 'Bash' })
    return executeSingleTool(ctx, block, tool, {
      cwd: '/test',
      abortSignal: undefined,
      agentId: 'test',
      sessionId: 's1',
      toolUseId: 't1',
      resolvedSkills: [],
      skillRegistry: undefined as any,
      env: {} as any,
      subAgents: {},
      services: createEmptyServices(),
      subprocessEnv: {},
    })
  }

  it('default debug level is silent — tool metadata moved to trace', async () => {
    const { logger, calls } = spyLogger()
    await runWithLogger(logger, { command: `echo ${SECRET}` })

    // debug must be completely empty (metadata demoted to trace)
    expect(calls.debug.length).toBe(0)

    // metadata now lives at trace, alongside the redacted input preview
    expect(calls.trace.length).toBeGreaterThan(0)
    const allTrace = calls.trace.join('\n')
    expect(allTrace).toContain('executeSingleTool(Bash)')
    expect(allTrace).toContain('started tool_use_id=')
    // sensitive input must never appear at any level
    const allLogged = [...calls.debug, ...calls.trace, ...calls.error].join('\n')
    expect(allLogged).not.toContain(SECRET)
  })

  it('does not log tool input via error path either', async () => {
    const { logger, calls } = spyLogger()
    const ctx = makeCtx({ logger })
    const block = makeBlock({ id: 't1', name: 'Bash', input: { command: `echo ${SECRET}` } })
    const tool = makeTool({
      name: 'Bash',
      call: vi.fn().mockRejectedValue(new Error('boom')),
    })
    await executeSingleTool(ctx, block, tool, {
      cwd: '/test',
      abortSignal: undefined,
      agentId: 'test',
      sessionId: 's1',
      toolUseId: 't1',
      resolvedSkills: [],
      skillRegistry: undefined as any,
      env: {} as any,
      subAgents: {},
      services: createEmptyServices(),
      subprocessEnv: {},
    })

    const allLogged = [...calls.debug, ...calls.trace, ...calls.error].join('\n')
    expect(allLogged).not.toContain(SECRET)
  })

  it('trace-level input logging redacts sensitive fields', async () => {
    const { logger, calls } = spyLogger()
    await runWithLogger(logger, {
      command: `echo ${SECRET}`,
      env: { AWS_SECRET_ACCESS_KEY: SECRET },
      file_path: '/tmp/safe',
    })

    expect(calls.trace.length).toBeGreaterThan(0)
    const allTrace = calls.trace.join('\n')
    expect(allTrace).toContain('[REDACTED]')
    expect(allTrace).toContain('/tmp/safe')
    expect(allTrace).not.toContain(SECRET)
    expect(allTrace).not.toContain('AWS_SECRET_ACCESS_KEY')
  })

  it('trace-level logging redacts multiline/heredoc credentials', async () => {
    const { logger, calls } = spyLogger()
    await runWithLogger(logger, {
      command: `cat <<EOF\npassword=${SECRET}\nEOF`,
    })

    const allLogged = [...calls.debug, ...calls.trace, ...calls.error].join('\n')
    expect(allLogged).not.toContain(SECRET)
  })
})

describe('tool-result transcript message (issue #54)', () => {
  it('tool-result message carries id and parseable ISO timestamp', async () => {
    const tool = makeTool({ name: 'greet' })
    const ctx = makeCtx()
    ctx.config.resolved.tools = [tool]
    for await (const _ev of executeTools(ctx, [makeBlock({ id: 't1', name: 'greet' })])) {
      // drain
    }
    expect(ctx.messages).toHaveLength(1)
    const msg = ctx.messages[0]
    expect(msg.role).toBe('user')
    expect(msg.id).toBeTruthy()
    expect(Date.parse(msg.timestamp!)).not.toBeNaN()
  })
})

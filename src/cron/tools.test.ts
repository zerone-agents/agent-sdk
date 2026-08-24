import { describe, expect, it, vi } from 'vitest'

import type { ToolContext } from '../types.js'
import type { CronService } from './service.js'
import type { CronTask } from './types.js'
import { CronCreateTool, CronDeleteTool, CronListTool } from '../tools/cron.js'
import { createEmptyServices } from '../tools/services.js'

/** Build a ToolContext whose services carry the given cron service mock. */
function contextWith(mock: CronService | null, agentId?: string): ToolContext {
  return {
    cwd: process.cwd(),
    ...(agentId ? { agentId } : {}),
    services: { ...createEmptyServices(), cron: mock },
  } as ToolContext
}

function createMockService() {
  return {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    suspend: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    create: vi.fn(async (input: { cron: string; prompt: string }) => ({
      id: 'task-1',
      cron: input.cron,
      prompt: input.prompt,
      createdAt: 1_000,
    })),
    list: vi.fn(async () => [] as CronTask[]),
    get: vi.fn(async () => null),
    update: vi.fn(async () => null),
    delete: vi.fn(async () => {}),
    runNow: vi.fn(async () => {
      throw new Error('runNow is host-only and must not be reachable from tools')
    }),
    listExecutions: vi.fn(async () => []),
    getExecution: vi.fn(async () => null),
  }
}

type MockService = ReturnType<typeof createMockService>

function asService(mock: MockService): CronService {
  return mock as unknown as CronService
}

function cronTask(overrides: Partial<CronTask> = {}): CronTask {
  return {
    id: 'task-1',
    cron: '*/5 * * * *',
    prompt: 'Run the report',
    createdAt: 1_000,
    ...overrides,
  }
}

describe('CronCreateTool', () => {
  it('requires cron and prompt fields before touching the service', async () => {
    const service = createMockService()
    const result = await CronCreateTool.call({ prompt: 'x' }, contextWith(asService(service)))

    expect(result.is_error).toBe(true)
    expect(result.content as string).toContain('requires cron and prompt')
    expect(service.create).not.toHaveBeenCalled()
  })

  it('delegates to service.create and reports id + next run', async () => {
    const service = createMockService()
    const result = await CronCreateTool.call(
      { cron: '*/5 * * * *', prompt: 'Run the report', agent: 'finance' },
      contextWith(asService(service)),
    )

    expect(service.create).toHaveBeenCalledWith({
      cron: '*/5 * * * *',
      prompt: 'Run the report',
      agentId: 'finance',
    })
    expect(result.is_error).toBeUndefined()
    expect(result.content).toContain('Cron task created: task-1 (Every 5 minutes). Next run: ')
  })

  it('falls back to context.agentId when the agent field is omitted', async () => {
    const service = createMockService()
    await CronCreateTool.call(
      { cron: '*/5 * * * *', prompt: 'Run the report' },
      contextWith(asService(service), 'default-agent'),
    )

    expect(service.create).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'default-agent' }),
    )
  })

  it('forwards an optional name', async () => {
    const service = createMockService()
    service.create.mockResolvedValue({
      id: 'task-1',
      name: 'report',
      cron: '*/5 * * * *',
      prompt: 'Run the report',
      createdAt: 1_000,
    })

    await CronCreateTool.call(
      { cron: '*/5 * * * *', prompt: 'Run the report', name: 'report' },
      contextWith(asService(service)),
    )

    expect(service.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'report' }),
    )
  })

  it('surfaces service validation errors as is_error results', async () => {
    const service = createMockService()
    service.create.mockRejectedValue(
      new Error('Invalid cron expression: "nope". Must be a valid 5-field cron (e.g. "0 16 * * *").'),
    )

    const result = await CronCreateTool.call(
      { cron: 'nope', prompt: 'x' },
      contextWith(asService(service)),
    )

    expect(result.is_error).toBe(true)
    expect(result.content).toContain('Invalid cron expression')
  })

  it('surfaces the task limit error from the service', async () => {
    const service = createMockService()
    service.create.mockRejectedValue(new Error('Cron task limit reached: maximum 50 tasks.'))

    const result = await CronCreateTool.call(
      { cron: '*/5 * * * *', prompt: 'x' },
      contextWith(asService(service)),
    )

    expect(result.is_error).toBe(true)
    expect(result.content).toContain('Cron task limit reached')
  })

  it('reports NOT INITIALIZED when the cron service is null', async () => {
    const result = await CronCreateTool.call(
      { cron: '*/5 * * * *', prompt: 'Run the report' },
      contextWith(null),
    )

    expect(result.is_error).toBe(true)
    expect(result.content).toBe('Cron service is not initialized.')
  })

  it('keeps the static default description (no agent enumeration)', () => {
    expect(CronCreateTool.description).toContain('Agent selection')
    expect(CronCreateTool.description).not.toContain('Available agents:')
  })
})

describe('CronDeleteTool', () => {
  it('requires an id field', async () => {
    const service = createMockService()
    const result = await CronDeleteTool.call({}, contextWith(asService(service)))

    expect(result.is_error).toBe(true)
    expect(result.content).toContain('requires an id field')
    expect(service.delete).not.toHaveBeenCalled()
  })

  it('delegates to service.delete and confirms', async () => {
    const service = createMockService()
    const result = await CronDeleteTool.call({ id: 'task-1' }, contextWith(asService(service)))

    expect(service.delete).toHaveBeenCalledWith('task-1')
    expect(result).toEqual({
      type: 'tool_result',
      tool_use_id: '',
      content: 'Cron task deleted: task-1',
    })
  })

  it('surfaces not-found errors from the service', async () => {
    const service = createMockService()
    service.delete.mockRejectedValue(new Error('Cron task not found: task-1'))

    const result = await CronDeleteTool.call({ id: 'task-1' }, contextWith(asService(service)))

    expect(result.is_error).toBe(true)
    expect(result.content).toContain('Cron task not found: task-1')
  })

  it('reports NOT INITIALIZED when the cron service is null', async () => {
    const result = await CronDeleteTool.call({ id: 'task-1' }, contextWith(null))

    expect(result.is_error).toBe(true)
    expect(result.content).toBe('Cron service is not initialized.')
  })
})

describe('CronListTool', () => {
  it('reports an empty schedule', async () => {
    const service = createMockService()
    const result = await CronListTool.call({}, contextWith(asService(service)))

    expect(result.content).toBe('No cron tasks scheduled.')
  })

  it('formats tasks including optional names', async () => {
    const service = createMockService()
    service.list.mockResolvedValue([
      cronTask({ id: 'task-1', cron: '*/5 * * * *' }),
      cronTask({
        id: 'task-2',
        name: 'weekday check',
        cron: '0 9 * * 1-5',
        prompt: 'Do a weekday check',
      }),
    ])

    const result = await CronListTool.call({}, contextWith(asService(service)))

    expect(result.is_error).toBeUndefined()
    expect(result.content).toBe(
      [
        '[task-1] Every 5 minutes cron="*/5 * * * *" prompt="Run the report"',
        '[task-2] "weekday check" Weekdays at 9:00 AM cron="0 9 * * 1-5" prompt="Do a weekday check"',
      ].join('\n'),
    )
  })

  it('reports NOT INITIALIZED when the cron service is null', async () => {
    const result = await CronListTool.call({}, contextWith(null))

    expect(result.is_error).toBe(true)
    expect(result.content).toBe('Cron service is not initialized.')
  })
})

describe('per-context isolation (ADR 0005)', () => {
  it('two contexts with different service mocks do not cross-contaminate', async () => {
    const serviceA = createMockService()
    serviceA.create.mockResolvedValue({
      id: 'task-A',
      cron: '*/5 * * * *',
      prompt: 'from A',
      createdAt: 1_000,
    })
    const serviceB = createMockService()
    serviceB.create.mockResolvedValue({
      id: 'task-B',
      cron: '*/5 * * * *',
      prompt: 'from B',
      createdAt: 1_000,
    })

    const resultA = await CronCreateTool.call(
      { cron: '*/5 * * * *', prompt: 'from A' },
      contextWith(asService(serviceA)),
    )
    const resultB = await CronCreateTool.call(
      { cron: '*/5 * * * *', prompt: 'from B' },
      contextWith(asService(serviceB)),
    )

    expect(serviceA.create).toHaveBeenCalledTimes(1)
    expect(serviceB.create).toHaveBeenCalledTimes(1)
    expect(resultA.content).toContain('task-A')
    expect(resultB.content).toContain('task-B')
  })
})

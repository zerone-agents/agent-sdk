import { describe, expect, it, vi } from 'vitest'
import { ToolSearchTool } from './find-tool.js'
import { createEmptyServices } from './services.js'
import type { ToolContext } from '../types.js'

async function callToolSearch(
  query: string,
  deferredTools: any[],
  existingActivated: string[] = [],
) {
  const services = createEmptyServices()
  services.toolSearch.deferredTools = deferredTools
  services.toolSearch.activatedTools = new Set(existingActivated)
  const ctx = {
    cwd: '/tmp',
    agentId: 'test',
    sessionId: 'test',
    subprocessEnv: {} as any,
    services,
  } as unknown as ToolContext
  const result = await ToolSearchTool.call({ query }, ctx)
  return { result, activated: services.toolSearch.activatedTools }
}

describe('FindTool activation', () => {
  it('activates matched tools on successful search', async () => {
    const deferred = [
      { name: 'CronList', description: 'list crons', call: vi.fn() },
      { name: 'CronCreate', description: 'create cron', call: vi.fn() },
    ]
    const { result, activated } = await callToolSearch('select:CronList,CronCreate', deferred)
    expect(result.is_error).toBeFalsy()
    expect(activated.has('CronList')).toBe(true)
    expect(activated.has('CronCreate')).toBe(true)
    // The response tells the model the schemas are now available
    expect(result.content).toContain('CronList')
    expect(result.content).toContain('CronCreate')
  })

  it('does not activate on non-matching query', async () => {
    const deferred = [{ name: 'CronList', description: 'list crons', call: vi.fn() }]
    const { activated } = await callToolSearch('select:Nonexistent', deferred)
    expect(activated.size).toBe(0)
  })

  it('accumulates activations across multiple calls (Set semantics)', async () => {
    const deferred = [
      { name: 'CronList', description: 'list crons', call: vi.fn() },
      { name: 'Config', description: 'read write config', call: vi.fn() },
    ]
    // First call activates CronList
    const { activated: after1 } = await callToolSearch('select:CronList', deferred)
    // Second call activates Config — pass after1 as existingActivated to simulate persistence
    const { activated: after2 } = await callToolSearch(
      'select:Config', deferred, Array.from(after1),
    )
    expect(after2.has('CronList')).toBe(true)
    expect(after2.has('Config')).toBe(true)
    expect(after2.size).toBe(2)
  })

  it('returns "No deferred tools available" when registry is empty', async () => {
    const { result, activated } = await callToolSearch('select:Foo', [])
    expect(result.content).toContain('No deferred tools available')
    expect(activated.size).toBe(0)
  })

  it('returns "No tools found" on non-matching keyword search', async () => {
    const deferred = [{ name: 'CronList', description: 'list crons', call: vi.fn() }]
    const { result, activated } = await callToolSearch('nonmatchingkeyword', deferred)
    expect(result.content).toContain('No tools found')
    expect(activated.size).toBe(0)
  })

  it('keyword search activates matching tools', async () => {
    const deferred = [
      { name: 'CronList', description: 'list scheduled cron tasks', call: vi.fn() },
      { name: 'Config', description: 'read write config', call: vi.fn() },
    ]
    const { result, activated } = await callToolSearch('cron', deferred)
    expect(activated.has('CronList')).toBe(true)
    expect(activated.has('Config')).toBe(false)
    expect(result.content).toContain('CronList')
  })

  it('response includes each tool\'s shortDescription when present', async () => {
    const deferred = [
      { name: 'CronList', description: 'long description', shortDescription: 'List scheduled tasks', call: vi.fn() },
    ]
    const { result } = await callToolSearch('select:CronList', deferred)
    // shortDescription is used, not the long description
    expect(result.content).toContain('- CronList: List scheduled tasks')
    expect(result.content).not.toContain('long description')
  })

  it('response falls back to description when shortDescription absent', async () => {
    const deferred = [
      { name: 'CronList', description: 'B'.repeat(250), call: vi.fn() },
    ]
    const { result } = await callToolSearch('select:CronList', deferred)
    expect(result.content).toContain('- CronList: ' + 'B'.repeat(200) + '...(more)')
  })
})

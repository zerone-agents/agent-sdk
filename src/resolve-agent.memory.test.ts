/**
 * resolveAgent memory mounting tests (issue #61): the Memory/MemorySearch
 * tools are appended to the base pool ONLY when a MemoryService is bound
 * (runtime.toolServices.memory != null). Once mounted they participate in
 * the allow/deny lists and the spawn pipeline like any built-in; Explore
 * spawns keep MemorySearch (read-only) and drop Memory.
 *
 * NOTE: resolveAgent never starts/stops services — createMemoryService alone
 * opens nothing, so the inline services below cannot leak.
 */

import { describe, expect, it } from 'vitest'
import { resolveAgent } from './resolve-agent.js'
import { createMemoryService } from './memory/service.js'
import { InMemoryMemoryStorage } from './memory/in-memory-storage.js'
import type { AgentCapabilities, AgentDefinition, ResolvedAgent, RuntimeEnvironment } from './types.js'
import type { ToolServices } from './tools/services.js'

async function resolveWith(
  memory: boolean,
  caps: AgentCapabilities = {},
  def: AgentDefinition = { description: 'a', prompt: '' },
): Promise<ResolvedAgent> {
  const services = {
    memory: memory ? createMemoryService({ storage: new InMemoryMemoryStorage() }) : null,
  } as unknown as ToolServices
  const runtime = {
    provider: {} as RuntimeEnvironment['provider'],
    model: 'test',
    maxTokens: 1000,
    cwd: '/repo',
    subprocessEnv: {},
    toolServices: services,
  } satisfies RuntimeEnvironment
  return resolveAgent(runtime, caps, def)
}

function explore(): ResolvedAgent {
  return resolveAgent(
    {
      provider: {} as RuntimeEnvironment['provider'],
      model: 'm',
      maxTokens: 1,
      cwd: '/repo',
      subprocessEnv: {},
      toolServices: {
        memory: createMemoryService({ storage: new InMemoryMemoryStorage() }),
      } as unknown as ToolServices,
    },
    {},
    { description: 'a', prompt: '' },
    { spawn: { mode: 'Explore' } },
  )
}

describe('resolveAgent memory mounting (issue #61)', () => {
  it('memoryService present → both deferred tools are discoverable', async () => {
    const resolved = await resolveWith(true)
    expect(resolved.deferredTools.map((t) => t.name).sort()).toEqual(expect.arrayContaining(['Memory', 'MemorySearch']))
    expect(resolved.tools.map((t) => t.name)).not.toContain('Memory')
  })

  it('memoryService absent → neither tool anywhere', async () => {
    const resolved = await resolveWith(false)
    expect(resolved.deferredTools.map((t) => t.name)).not.toContain('Memory')
    expect(resolved.tools.map((t) => t.name)).not.toContain('MemorySearch')
  })

  it('allow/disallow filtering applies to the memory tools', async () => {
    const resolved = await resolveWith(true, { disallowedTools: ['Memory'] })
    const names = [...resolved.tools.map((t) => t.name), ...resolved.deferredTools.map((t) => t.name)]
    expect(names).toContain('MemorySearch')
    expect(names).not.toContain('Memory')
  })

  it('Explore spawn keeps MemorySearch (read-only) and drops Memory', () => {
    const resolved = explore()
    const names = [...resolved.tools.map((t) => t.name), ...resolved.deferredTools.map((t) => t.name)]
    expect(names).toContain('MemorySearch')
    expect(names).not.toContain('Memory')
  })
})
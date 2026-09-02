/**
 * Issue #72 regression matrix — Agent-local capabilities isolation.
 *
 * 11 assertions from the issue's 回归测试矩阵:
 *  1. root sees only parent capabilities
 *  2. child-a sees only child-a capabilities (no parent / no sibling)
 *  3. child-b inherits nothing, no fallback
 *  4. allowedTools/disallowedTools use the child's own policy
 *  5. General child-a keeps its own write + read tools
 *  6. Explore child-a keeps readOnly + Bash only; write MCP/Custom filtered
 *  7. Task/MultiTask invisible in every subagent
 *  8. Provider/Model/credentials/cwd/subprocessEnv identical to parent Runtime
 *  9. deferred connection tools discoverable only in the child's own catalog
 * 10. same endpoint (shared tool instances) reusable across agents, visibility isolated
 * 11. SDK uses the host-provided child prompt, never falls back to the parent's
 */

import { describe, it, expect, vi } from 'vitest'
import type {
  AgentDefinition,
  AgentCapabilities,
  RuntimeEnvironment,
  ToolDefinition,
} from '../types.js'
import { createEmptyServices } from './services.js'

vi.mock('../engine.js', () => ({ QueryEngine: vi.fn() }))

// Base pool mirroring spawn-subagent.test.ts: FindTool (eager) enables the
// lazy split; Skill keeps caps.skills alive through cross-validation.
const MOCK_TOOLS: ToolDefinition[] = [
  { name: 'Read', isReadOnly: () => true, call: vi.fn() } as any,
  { name: 'Glob', isReadOnly: () => true, call: vi.fn() } as any,
  { name: 'Grep', isReadOnly: () => true, call: vi.fn() } as any,
  { name: 'Bash', isReadOnly: () => false, call: vi.fn() } as any,
  { name: 'Write', isReadOnly: () => false, call: vi.fn() } as any,
  { name: 'Edit', isReadOnly: () => false, call: vi.fn() } as any,
  { name: 'Task', isReadOnly: () => false, call: vi.fn() } as any,
  { name: 'MultiTask', isReadOnly: () => false, call: vi.fn() } as any,
  { name: 'FindTool', isReadOnly: () => true, call: vi.fn() } as any,
  { name: 'Skill', isReadOnly: () => true, call: vi.fn() } as any,
]

vi.mock('./index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./index.js')>()
  return {
    ...actual,
    getAllBaseTools: () => [...MOCK_TOOLS],
  }
})

const { QueryEngine } = await import('../engine.js')
const { runSubagent } = await import('./spawn-subagent.js')
const { resolveAgent } = await import('../resolve-agent.js')
const { SkillRegistry } = await import('../skills/registry.js')

// ============================================================================
// Fixtures: parent / child-a / child-b capability sets
// ============================================================================

function toolDef(name: string, opts: { readOnly?: boolean; deferred?: boolean } = {}): ToolDefinition {
  return {
    name,
    isReadOnly: () => opts.readOnly ?? false,
    deferred: opts.deferred ?? false,
    shortDescription: opts.deferred ? `${name} short` : undefined,
    call: vi.fn(),
  } as any
}

const skillDef = (name: string) =>
  ({ name, description: `${name} desc`, getPrompt: async () => [] } as any)

const parentMcp = toolDef('mcp__parent__op', { readOnly: true, deferred: true })
const parentCustom = toolDef('parent_custom', { readOnly: true })
const parentSkill = skillDef('parent_skill')

const childAmcp = toolDef('mcp__a__op', { readOnly: true, deferred: true })
const childAWrite = toolDef('mcp__a__mutate', { readOnly: false })
const childACustom = toolDef('child_a_custom', { readOnly: true })
const childAWriteCustom = toolDef('child_a_write_custom', { readOnly: false })
const childASkill = skillDef('child_a_skill')

const runtime: RuntimeEnvironment = {
  provider: { apiType: 'anthropic-messages', createMessage: vi.fn() } as any,
  model: 'test-model',
  maxTokens: 4096,
  cwd: '/workspace',
  subprocessEnv: { PATH: '/usr/bin' },
  toolServices: createEmptyServices(),
}

function rootCaps(): AgentCapabilities {
  return {
    connectionTools: [parentMcp],
    customTools: [parentCustom],
    skills: [parentSkill],
  }
}

const ROOT_DEF: AgentDefinition = { description: 'root', prompt: 'root prompt' }

const subAgents: Record<string, AgentDefinition> = {
  'child-a': {
    description: 'a',
    prompt: 'child-a prompt',
    capabilities: {
      connectionTools: [childAmcp, childAWrite],
      customTools: [childACustom, childAWriteCustom],
      skills: [childASkill],
      allowedTools: ['Read', 'Bash', 'Skill', 'FindTool'],
    },
  },
  'child-b': { description: 'b', prompt: 'child-b prompt' },  // all Agent-local capabilities empty
}

// ============================================================================
// Helpers
// ============================================================================

let captured: any

function captureEngine() {
  ;(QueryEngine as any).mockImplementation(function (this: any, config: any) {
    captured = config
    this.submitMessage = async function* () {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }
    }
  })
}

function spawnOpts(agentName: string, mode: 'General' | 'Explore' = 'General') {
  return {
    runtime,
    subAgents,
    agentName,
    fallbackAgentId: agentName,
    mode,
    prompt: 'do it',
    description: 'matrix',
    toolUseId: 'tu_1',
    taskIndex: 0,
  }
}

const allNames = (r: any) => [...r.tools, ...r.deferredTools].map((t: any) => t.name)
const capabilityNames = (names: string[]) =>
  names.filter((n) => n.startsWith('mcp__') || n.includes('_custom'))

// ============================================================================
// Matrix
// ============================================================================

describe('issue #72 regression matrix', () => {
  it('#1 root sees only parent capabilities', () => {
    const r = resolveAgent(runtime, rootCaps(), ROOT_DEF, { skillRegistry: new SkillRegistry() })
    const names = allNames(r)
    expect(names).toContain('mcp__parent__op')
    expect(names).toContain('parent_custom')
    expect(names).not.toContain('mcp__a__op')
    expect(names).not.toContain('child_a_custom')
    expect(r.skills.map((s: any) => s.name)).toEqual(['parent_skill'])
    expect(r.deferredTools.map((t: any) => t.name)).toEqual(['mcp__parent__op'])
  })

  it('#2 #5 #7 #11 General child-a: own capabilities only, write+read kept, no nesting, host prompt', async () => {
    captureEngine()
    await runSubagent(spawnOpts('child-a'))
    const r = captured.resolved
    const names = allNames(r)
    // #2: exactly child-a's own capability tools (order: eager pool, then deferred catalog)
    expect(capabilityNames(names))
      .toEqual(['child_a_custom', 'child_a_write_custom', 'mcp__a__mutate', 'mcp__a__op'])
    expect(r.skills.map((s: any) => s.name)).toEqual(['child_a_skill'])
    // #5: General keeps own write AND read tools
    expect(names).toContain('mcp__a__mutate')
    expect(names).toContain('mcp__a__op')
    // #7: nesting ban
    expect(names).not.toContain('Task')
    expect(names).not.toContain('MultiTask')
    // #11: host-provided child prompt, never a parent fallback
    expect(r.definition.prompt).toContain('child-a prompt')
  })

  it('#3 child-b with all-empty capabilities inherits nothing, no fallback', async () => {
    captureEngine()
    await runSubagent(spawnOpts('child-b'))
    const r = captured.resolved
    const names = allNames(r)
    expect(capabilityNames(names)).toEqual([])
    expect(r.skills).toEqual([])
    expect(r.deferredTools).toEqual([])
    expect(names).not.toContain('Task')
    expect(names).not.toContain('MultiTask')
  })

  it('#4 allow/deny policy is the child\'s own (no parent policy inheritance)', async () => {
    // child-a's allowedTools gates built-ins to Read/Bash/Skill/FindTool
    captureEngine()
    await runSubagent(spawnOpts('child-a'))
    const aNames = allNames(captured.resolved)
    expect(aNames).toContain('Read')
    expect(aNames).toContain('Bash')
    expect(aNames).not.toContain('Write')
    expect(aNames).not.toContain('Edit')

    // child-b has NO policy → full builtin pool (never copies sibling/parent policy)
    captureEngine()
    await runSubagent(spawnOpts('child-b'))
    const bNames = allNames(captured.resolved)
    expect(bNames).toContain('Write')
    expect(bNames).toContain('Edit')
  })

  it('#6 Explore child-a: readOnly + Bash only; write MCP/Custom filtered from pool AND catalog', async () => {
    captureEngine()
    await runSubagent(spawnOpts('child-a', 'Explore'))
    const r = captured.resolved
    const names = allNames(r)
    expect(names).toContain('Bash')
    expect(names).toContain('Read')
    expect(names).not.toContain('Write')
    expect(names).not.toContain('mcp__a__mutate')        // write MCP filtered
    expect(names).not.toContain('child_a_write_custom')  // write custom filtered
    expect(names).toContain('child_a_custom')            // read-only custom survives
    expect(names).toContain('mcp__a__op')                // read-only deferred stays discoverable
    expect(r.deferredTools.map((t: any) => t.name)).toEqual(['mcp__a__op'])
  })

  it('#8 Runtime globals inherited by reference (provider carries credentials)', async () => {
    captureEngine()
    await runSubagent(spawnOpts('child-a'))
    expect(captured.runtime.provider).toBe(runtime.provider)
    expect(captured.runtime.model).toBe(runtime.model)
    expect(captured.runtime.cwd).toBe(runtime.cwd)
    expect(captured.runtime.subprocessEnv).toBe(runtime.subprocessEnv)
  })

  it('#9 deferred connection tools live in the child\'s own catalog only', async () => {
    // child-a's catalog holds its deferred tool on a FRESH findTool registry
    captureEngine()
    await runSubagent(spawnOpts('child-a'))
    expect(captured.resolved.deferredTools.map((t: any) => t.name)).toEqual(['mcp__a__op'])
    expect(captured.resolved.services.findTool).not.toBe(runtime.toolServices.findTool)

    // child-b's catalog is empty
    captureEngine()
    await runSubagent(spawnOpts('child-b'))
    expect(captured.resolved.deferredTools).toEqual([])

    // root's catalog has only parent tools — never child tools
    const root = resolveAgent(runtime, rootCaps(), ROOT_DEF, { skillRegistry: new SkillRegistry() })
    expect(root.deferredTools.map((t: any) => t.name)).toEqual(['mcp__parent__op'])
  })

  it('#10 shared endpoint (same tool instances) across agents, visibility still isolated', async () => {
    // Host materialized ONE connection; two entries share the instances.
    const shared = toolDef('mcp__shared__op', { readOnly: true })
    const aCaps = subAgents['child-a'].capabilities!
    const subs: Record<string, AgentDefinition> = {
      a: { ...subAgents['child-a'], capabilities: { ...aCaps, connectionTools: [shared] } },
      b: { ...subAgents['child-b'], capabilities: { connectionTools: [shared] } },
    }

    captureEngine()
    await runSubagent({ ...spawnOpts('a'), subAgents: subs })
    const aNames = allNames(captured.resolved)
    expect(aNames).toContain('mcp__shared__op')
    expect(aNames).not.toContain('mcp__a__op')   // swapped out — visibility follows the entry
    expect(aNames).toContain('child_a_custom')   // rest of a's capabilities intact

    captureEngine()
    await runSubagent({ ...spawnOpts('b'), subAgents: subs })
    const bNames = allNames(captured.resolved)
    expect(bNames).toContain('mcp__shared__op')
    expect(bNames.filter((n: string) => n.startsWith('mcp__'))).toEqual(['mcp__shared__op'])
  })
})

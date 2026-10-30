import { describe, it, expect, vi } from 'vitest'

const MOCK_TOOLS = [
  { name: 'Read', isReadOnly: () => true, call: vi.fn() },
  { name: 'Write', isReadOnly: () => false, call: vi.fn() },
  { name: 'Bash', isReadOnly: () => false, call: vi.fn() },
  { name: 'Task', isReadOnly: () => false, call: vi.fn() },
  { name: 'MultiTask', isReadOnly: () => false, call: vi.fn() },
  { name: 'Skill', isReadOnly: () => true, call: vi.fn() },
  { name: 'FindTool', isReadOnly: () => true, call: vi.fn() },
  { name: 'CronList', isReadOnly: () => true, call: vi.fn(), deferred: true, shortDescription: 'List scheduled tasks' },
] as any[]

vi.mock('./tools/index.js', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return {
    ...actual,
    getAllBaseTools: () => [...MOCK_TOOLS],
  }
})

import { resolveAgent } from './resolve-agent.js'
import { AskUserQuestionTool } from './tools/ask-user.js'
import { resolvePrompt } from './prompts/system-prompts.js'
import { SkillRegistry, filterSkillsByAllowlist } from './skills/registry.js'
import type { AgentCapabilities, RuntimeEnvironment } from './types.js'

const DEF = { description: 'd', prompt: 'p' }
const COMMIT_SKILL = { name: 'commit', description: 'd', getPrompt: async () => [] } as any
const REVIEW_SKILL = { name: 'review', description: 'd', getPrompt: async () => [] } as any

function makeRuntime(overrides: Partial<RuntimeEnvironment> = {}): RuntimeEnvironment {
  return {
    provider: { apiType: 'anthropic-messages', createMessage: vi.fn() } as any,
    model: 'test-model',
    maxTokens: 1000,
    cwd: '/tmp',
    subprocessEnv: {},
    toolServices: {
      askUser: null,
      findTool: { deferredTools: [], activatedTools: new Set() },
      config: new Map(),
      cron: null,
    },
    ...overrides,
  }
}

describe('resolveAgent', () => {
  it('returns full builtin pool when no allow/deny lists', () => {
    const r = resolveAgent(makeRuntime(), {}, DEF)
    expect(r.tools.map(t => t.name)).toEqual(['Read', 'Write', 'Bash', 'Task', 'MultiTask', 'Skill', 'FindTool'])
  })

  it('applies allowedTools then disallowedTools (deny wins)', () => {
    const r = resolveAgent(makeRuntime(), {
      allowedTools: ['Read', 'Write', 'Bash'],
      disallowedTools: ['Bash'],
    }, DEF)
    expect(r.tools.map(t => t.name)).toEqual(['Read', 'Write'])
  })

  it('merges customTools and connectionTools into the pool with dedupe by name', () => {
    const custom = { name: 'MyTool', isReadOnly: () => true, call: vi.fn() } as any
    const conn = { name: 'Read', description: 'mcp override', isReadOnly: () => true, call: vi.fn() } as any
    const r = resolveAgent(makeRuntime(), { customTools: [custom], connectionTools: [conn] }, DEF)
    const names = r.tools.map(t => t.name)
    expect(names).toContain('MyTool')
    expect(names.filter(n => n === 'Read')).toHaveLength(1)
    expect(r.tools.find(t => t.name === 'Read')?.description).toBe('mcp override')
  })

  it('caps.skills is the agent-owned set (availableSkills filtering is the root caller\'s job)', () => {
    // Simulates Agent.buildRootCapabilities: registry view filtered by the
    // root-only availableSkills allowlist, handed in as caps.skills.
    const registryView = [COMMIT_SKILL, REVIEW_SKILL]
    const caps: AgentCapabilities = {
      skills: filterSkillsByAllowlist(registryView, ['commit']),
    }
    const r = resolveAgent(makeRuntime(), caps, DEF)
    expect(r.skills.map(s => s.name)).toEqual(['commit'])
  })

  it('drops skills when Skill tool is filtered out via allowedTools', () => {
    const r = resolveAgent(makeRuntime(), { skills: [COMMIT_SKILL], allowedTools: ['Read'] }, DEF)
    expect(r.tools.map(t => t.name)).toEqual(['Read'])
    expect(r.skills).toEqual([])
  })

  it('drops skills when Skill tool is excluded via disallowedTools', () => {
    const r = resolveAgent(makeRuntime(), { skills: [COMMIT_SKILL], disallowedTools: ['Skill'] }, DEF)
    expect(r.tools.map(t => t.name)).not.toContain('Skill')
    expect(r.skills).toEqual([])
  })

  it('preserves skills when Skill tool is in allowedTools (regression)', () => {
    const r = resolveAgent(makeRuntime(), { skills: [COMMIT_SKILL], allowedTools: ['Read', 'Skill'] }, DEF)
    expect(r.tools.map(t => t.name)).toEqual(['Read', 'Skill'])
    expect(r.skills.map(s => s.name)).toEqual(['commit'])
  })

  it('splits deferred tools from eager when FindTool is available', () => {
    const r = resolveAgent(makeRuntime(), {}, DEF)
    // MOCK_TOOLS has 8 entries: 7 eager + 1 deferred (CronList)
    expect(r.tools.map(t => t.name)).toEqual(
      ['Read', 'Write', 'Bash', 'Task', 'MultiTask', 'Skill', 'FindTool'],
    )
    expect(r.deferredTools.map(t => t.name)).toEqual(['CronList'])
  })

  it('preserves shortDescription on deferred tools', () => {
    const r = resolveAgent(makeRuntime(), {}, DEF)
    expect(r.deferredTools[0].shortDescription).toBe('List scheduled tasks')
  })

  it('disables lazy-loading when disallowedTools excludes FindTool', () => {
    const r = resolveAgent(makeRuntime(), { disallowedTools: ['FindTool'] }, DEF)
    // Fallback: ALL filtered tools (including CronList) go to eager
    expect(r.tools.map(t => t.name)).toContain('CronList')
    expect(r.tools.map(t => t.name)).not.toContain('FindTool')
    expect(r.deferredTools).toEqual([])
  })

  it('disables lazy-loading when allowedTools omits FindTool', () => {
    const r = resolveAgent(makeRuntime(), { allowedTools: ['Read', 'Write', 'CronList'] }, DEF)
    // FindTool not in allow-list → lazy-loading disabled → CronList forced eager
    expect(r.tools.map(t => t.name)).toEqual(['Read', 'Write', 'CronList'])
    expect(r.deferredTools).toEqual([])
  })

  it('enables lazy-loading when allowedTools includes FindTool', () => {
    const r = resolveAgent(makeRuntime(), { allowedTools: ['Read', 'FindTool', 'CronList'] }, DEF)
    expect(r.tools.map(t => t.name)).toEqual(['Read', 'FindTool'])
    expect(r.deferredTools.map(t => t.name)).toEqual(['CronList'])
  })
})

describe('resolveAgent source-based filtering contract (issue #64 review)', () => {
  const mcpA = { name: 'mcp__srv__alpha', isReadOnly: () => true, call: vi.fn() } as any
  const mcpB = { name: 'mcp__srv__beta', isReadOnly: () => true, call: vi.fn() } as any
  const custom = { name: 'my_custom', isReadOnly: () => false, call: vi.fn() } as any

  it('connection tools bypass allowedTools (allow-list gates built-ins only)', () => {
    const r = resolveAgent(
      makeRuntime(),
      { connectionTools: [mcpA, mcpB], allowedTools: ['Read'] },
      DEF,
    )
    const names = r.tools.map(t => t.name)
    expect(names).toContain('Read')
    expect(names).toContain('mcp__srv__alpha')
    expect(names).toContain('mcp__srv__beta')
    // unlisted built-ins are still gated
    expect(names).not.toContain('Write')
    expect(names).not.toContain('Bash')
  })

  it('custom tools bypass allowedTools', () => {
    const r = resolveAgent(
      makeRuntime(),
      { customTools: [custom], allowedTools: ['Read'] },
      DEF,
    )
    const names = r.tools.map(t => t.name)
    expect(names).toContain('my_custom')
    expect(names).toContain('Read')
    expect(names).not.toContain('Write')
  })

  it('disallowedTools still applies to connection tools (deny runs on the merged pool)', () => {
    const r = resolveAgent(
      makeRuntime(),
      {
        connectionTools: [mcpA, mcpB],
        allowedTools: ['Read'],
        disallowedTools: ['mcp__srv__beta'],
      },
      DEF,
    )
    const names = r.tools.map(t => t.name)
    expect(names).toContain('mcp__srv__alpha')
    expect(names).not.toContain('mcp__srv__beta')
  })

  it('deny-list wildcard removes connection tools while unlisted base tools survive', () => {
    const r = resolveAgent(
      makeRuntime(),
      { connectionTools: [mcpA, mcpB], disallowedTools: ['mcp__srv__*'] },
      DEF,
    )
    const names = r.tools.map(t => t.name)
    expect(names).toContain('Read')
    expect(names).not.toContain('mcp__srv__alpha')
    expect(names).not.toContain('mcp__srv__beta')
  })

  it('warns when the final pool resolves to zero tools', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const r = resolveAgent(
        makeRuntime(),
        { allowedTools: ['DoesNotExist'] },
        DEF,
      )
      expect(r.tools).toEqual([])
      const warns = warn.mock.calls.map(c => String(c[0]))
      // scope warning from applyAllowedTools + final-pool warning from resolveAgent
      expect(warns.some(w => w.includes('matched none of the 8 built-in tools'))).toBe(true)
      expect(warns.some(w => w.includes('resolved to zero tools'))).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })
})

describe('resolveAgent spawn pipeline (issue #72)', () => {
  it('merges caps pools with base tools; custom/connection bypass allow-list', () => {
    const custom = { name: 'C1', isReadOnly: () => true, call: vi.fn() } as any
    const conn = { name: 'mcp__x__y', isReadOnly: () => false, call: vi.fn() } as any
    const r = resolveAgent(
      makeRuntime(),
      { customTools: [custom], connectionTools: [conn], allowedTools: ['Read'] },
      DEF,
    )
    const names = r.tools.map(t => t.name)
    expect(names).toContain('Read')
    expect(names).not.toContain('Bash')        // allow-list gates built-ins
    expect(names).toContain('C1')              // custom bypasses allow-list
    expect(names).toContain('mcp__x__y')       // connection bypasses allow-list
  })

  it('spawn removes Task/MultiTask after allow/deny', () => {
    const r = resolveAgent(makeRuntime(), {}, DEF, { spawn: { mode: 'General' } })
    const names = r.tools.map(t => t.name)
    expect(names).not.toContain('Task')
    expect(names).not.toContain('MultiTask')
  })

  it('Explore keeps only readOnly tools + Bash, write tools undiscoverable in deferred catalog', () => {
    const roDeferred = { name: 'mcp__ro__peek', isReadOnly: () => true, deferred: true, shortDescription: 's', call: vi.fn() } as any
    const wrDeferred = { name: 'mcp__wr__mutate', isReadOnly: () => false, deferred: true, shortDescription: 's', call: vi.fn() } as any
    const r = resolveAgent(
      makeRuntime(),
      { connectionTools: [roDeferred, wrDeferred] },
      DEF,
      { spawn: { mode: 'Explore' } },
    )
    expect(r.tools.some(t => t.name === 'Bash')).toBe(true)
    expect(r.tools.some(t => t.name === 'Write')).toBe(false)
    const deferredNames = r.deferredTools.map(t => t.name)
    expect(deferredNames).toContain('mcp__ro__peek')
    expect(deferredNames).not.toContain('mcp__wr__mutate')
  })

  it('spawn builds fresh SkillRegistry from caps.skills; no skills without caps', () => {
    const skill = { name: 's1', description: 'd', getPrompt: async () => [] } as any
    const r = resolveAgent(
      makeRuntime(), { skills: [skill] }, DEF, { spawn: { mode: 'General' } },
    )
    expect(r.skills.map(s => s.name)).toEqual(['s1'])
    expect(r.skillRegistry.get('s1')).toBeDefined()
    const empty = resolveAgent(makeRuntime(), {}, DEF, { spawn: { mode: 'General' } })
    expect(empty.skills).toEqual([])
  })

  it('root with explicit [] builds an empty registry, not opts.skillRegistry (#151)', () => {
    const reg = new SkillRegistry()
    const r = resolveAgent(makeRuntime(), { skills: [] }, DEF, { skillRegistry: reg })
    expect(r.skillRegistry).not.toBe(reg)
    expect(r.skillRegistry.getUserInvocable()).toEqual([])
  })

  it('uses runtime.toolServices as resolved.services', () => {
    const rt = makeRuntime()
    const r = resolveAgent(rt, {}, DEF)
    expect(r.services).toBe(rt.toolServices)
  })
})

describe('resolvePrompt', () => {
  it('returns undefined for undefined/empty', () => {
    expect(resolvePrompt(undefined)).toBeUndefined()
    expect(resolvePrompt('')).toBeUndefined()
  })
  it('passes through plain strings', () => {
    expect(resolvePrompt('hello')).toBe('hello')
  })
  it('resolves presets and append', () => {
    expect(resolvePrompt({ type: 'preset', preset: 'default' })).toContain('helpful assistant')
    expect(resolvePrompt({ type: 'preset', preset: 'default', append: 'EXTRA' })).toContain('EXTRA')
  })
})

describe('resolveAgent diagnostics (#78)', () => {
  it('zero-tools warn reaches injected sink', () => {
    const events: Array<{ level: string; msg: string }> = []
    const sink = {
      debug: () => {}, trace: () => {},
      warn: (msg: string) => events.push({ level: 'warn', msg }),
      error: (msg: string) => events.push({ level: 'error', msg }),
      child: () => sink,
    }
    resolveAgent(makeRuntime(), { allowedTools: ['Nonexistent*'] }, DEF, { diagnostics: sink as any })
    const e = events.find((x) => x.msg.includes('agent resolved to zero tools'))
    expect(e).toBeDefined()
    expect(e!.level).toBe('warn')
  })
})

describe('resolveAgent spawn pipeline: AskUserQuestion (issue #154)', () => {
  // The shared MOCK_TOOLS above does not carry AskUserQuestion (its real
  // mounting is host-service-dependent), so these pins inject the REAL
  // built-in definition (imported past the tools/index mock). Custom tools
  // bypass allow-lists and participate in ALL downstream filtering, so the
  // pins exercise the name-based spawn filter itself — including the deferred
  // (FindTool catalog) path — and fail loudly if the real tool is renamed.
  it('the filter literal tracks the real built-in name', () => {
    expect(AskUserQuestionTool.name).toBe('AskUserQuestion')
    expect(AskUserQuestionTool.deferred).toBe(true)
  })

  it('General spawn removes the real AskUserQuestionTool from the eager pool AND the FindTool catalog', () => {
    const r = resolveAgent(makeRuntime(), { customTools: [AskUserQuestionTool] }, DEF, { spawn: { mode: 'General' } })
    const names = [...r.tools, ...r.deferredTools].map((t) => t.name)
    expect(names).not.toContain('AskUserQuestion')
  })

  it('Explore spawn removes it from pool and catalog too', () => {
    const r = resolveAgent(makeRuntime(), { customTools: [AskUserQuestionTool] }, DEF, { spawn: { mode: 'Explore' } })
    const names = [...r.tools, ...r.deferredTools].map((t) => t.name)
    expect(names).not.toContain('AskUserQuestion')
  })

  it('parent agent keeps the real AskUserQuestionTool (control case: deferred-discoverable)', () => {
    const r = resolveAgent(makeRuntime(), { customTools: [AskUserQuestionTool] }, DEF)
    const names = [...r.tools, ...r.deferredTools].map((t) => t.name)
    expect(names).toContain('AskUserQuestion')
  })
})

// #151: an explicit capabilities.skills means the agent OWNS its skill set —
// the execution registry must be rebuilt from it (spawn-symmetric), never
// silently falling back to the session registry. Only the unset path keeps
// opts.skillRegistry (registry-as-superset allowed).
describe('explicit skills registry consistency (#151)', () => {
  const SKILL_A = { name: 'skill-a', description: 'a', getPrompt: async () => [] } as any
  const SKILL_B = { name: 'skill-b', description: 'b', getPrompt: async () => [] } as any

  it('T1: explicit skills rebuild the execution registry (issue repro)', () => {
    const sessionReg = new SkillRegistry()          // empty — the runtime pre-materializes scenario
    const r = resolveAgent(makeRuntime(), { skills: [SKILL_A] }, DEF, { skillRegistry: sessionReg })
    expect(r.skills.map((s: any) => s.name)).toEqual(['skill-a'])
    expect(r.skillRegistry.get('skill-a')).toBeDefined()
    expect(r.skillRegistry).not.toBe(sessionReg)   // rebuilt, not the session registry
  })

  it('T2: explicit empty array means NO skills — never inherits opts.skillRegistry', () => {
    const sessionReg = new SkillRegistry()
    sessionReg.register(SKILL_B)
    const r = resolveAgent(makeRuntime(), { skills: [] }, DEF, { skillRegistry: sessionReg })
    expect(r.skills).toEqual([])
    expect(r.skillRegistry.getUserInvocable()).toEqual([])
    expect(r.skillRegistry).not.toBe(sessionReg)
  })

  it('T3: unset skills keep the registry view + allowlist (superset semantics preserved)', () => {
    const sessionReg = new SkillRegistry()
    sessionReg.register(SKILL_A)
    sessionReg.register(SKILL_B)
    const def = { ...DEF, availableSkills: ['skill-a'] }
    const r = resolveAgent(makeRuntime(), {}, def, { skillRegistry: sessionReg })
    // view = registry ∩ allowlist (project-sourced would pass too — none here)
    expect(r.skills.map((s: any) => s.name)).toEqual(['skill-a'])
    expect(r.skillRegistry).toBe(sessionReg)       // superset semantics: registry untouched
  })

  it('T4: unset skills without opts.skillRegistry — empty view, no throw', () => {
    const r = resolveAgent(makeRuntime(), {}, DEF)
    expect(r.skills).toEqual([])
    expect(r.skillRegistry.getUserInvocable()).toEqual([])
  })

  it('T5: spawn never inherits — even with a type-legal spawn+skillRegistry call (W1 pin)', () => {
    const sessionReg = new SkillRegistry()
    sessionReg.register(SKILL_B)
    const r = resolveAgent(makeRuntime(), {}, DEF, { spawn: { mode: 'General' }, skillRegistry: sessionReg })
    expect(r.skills).toEqual([])                   // structural, not convention
    expect(r.skillRegistry.getUserInvocable()).toEqual([])
    expect(r.skillRegistry).not.toBe(sessionReg)
  })

  it('T6: unknown skill name fails with the REAL available list (via SkillTool)', async () => {
    const { SkillTool } = await import('./tools/skill.js')
    const r = resolveAgent(makeRuntime(), { skills: [SKILL_A] }, DEF, { skillRegistry: new SkillRegistry() })
    const ctx = {
      toolUseId: 'tu_t6',
      resolvedSkills: r.skills,
      skillRegistry: r.skillRegistry,
    } as any
    const result: any = await SkillTool.call({ skill: 'nope' }, ctx)
    expect(result.is_error).toBe(true)
    expect(result.content).toContain('Unknown skill "nope"')
    expect(result.content).toContain('skill-a')    // the real registry contents, not "none"
  })
})

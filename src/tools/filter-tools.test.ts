import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { filterTools, applyAllowedTools, applyDisallowedTools } from './index.js'
import type { ToolDefinition } from '../types.js'

/**
 * Regression coverage for issue #64 (+ review round 1): trailing-* wildcard
 * support, source-based filtering contract, and diagnostics.
 *
 * Contract (review): the allow-list gates built-in base tools ONLY — custom
 * and MCP tools bypass it; the deny-list applies to the whole pool. A bare
 * `*` is asymmetric: allow-side selects everything; deny-side is a literal
 * no-op (preserving historical deny-list semantics).
 */

function tool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: 'object', properties: {} },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
    async call() {
      return { type: 'tool_result', tool_use_id: '', content: '', is_error: false }
    },
  }
}

const POOL = [
  tool('Read'),
  tool('Write'),
  tool('Bash'),
  tool('FindTool'),
  tool('mcp__utilities__get_temperature'),
  tool('mcp__utilities__convert_units'),
  tool('mcp__knowledge__knowledge_search'),
].map((t) => Object.freeze(t))

function names(tools: ToolDefinition[]): string[] {
  return tools.map((t) => t.name)
}

describe('applyAllowedTools wildcard matching (issue #64)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('admits every tool under a trailing-* prefix', () => {
    const result = applyAllowedTools(POOL, ['mcp__utilities__*'])
    expect(names(result)).toEqual([
      'mcp__utilities__get_temperature',
      'mcp__utilities__convert_units',
    ])
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('supports mixed exact + wildcard entries', () => {
    const result = applyAllowedTools(POOL, ['Read', 'mcp__knowledge__*'])
    expect(names(result)).toEqual(['Read', 'mcp__knowledge__knowledge_search'])
  })

  it('exact-name entries behave exactly as before (regression)', () => {
    const result = applyAllowedTools(POOL, ['Read', 'Bash'])
    expect(names(result)).toEqual(['Read', 'Bash'])
    expect(console.warn).not.toHaveBeenCalled()
  })

  it("allow-side bare '*' selects everything (review round 2), silently", () => {
    // Asymmetric semantics: allow-side '*' = allow-all; the deny-side keeps
    // '*' as a literal no-op (see applyDisallowedTools tests).
    const result = applyAllowedTools(POOL, ['*'])
    expect(names(result)).toEqual(names(POOL))
    expect(console.warn).not.toHaveBeenCalled()
  })

  it("bare '*' does not skip stale diagnostics for other entries (review round 3)", () => {
    // allow-all via '*', but 'Ghost*' matches nothing → stale warning still fires
    const result = applyAllowedTools(POOL, ['*', 'Ghost*'])
    expect(names(result)).toEqual(names(POOL))
    const warns = vi.mocked(console.warn).mock.calls.map((c) => String(c[0]))
    expect(warns.some((w) => w.includes('Ghost*') && w.includes('matches no tools'))).toBe(true)
  })

  it('a non-trailing * stays a literal (boundary semantics)', () => {
    const result = applyAllowedTools(POOL, ['mcp*search'])
    expect(result).toEqual([])
  })
})

describe('applyDisallowedTools wildcard matching (issue #64)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('removes every tool under a trailing-* prefix', () => {
    const result = applyDisallowedTools(POOL, ['mcp__utilities__*'])
    expect(names(result)).toEqual(names(POOL).filter((n) => !n.startsWith('mcp__utilities__')))
    expect(console.warn).not.toHaveBeenCalled()
  })

  it("disallowedTools: ['*'] removes nothing (historical literal semantics preserved)", () => {
    // Review round 1: bare '*' must NOT become deny-all.
    const result = applyDisallowedTools(POOL, ['*'])
    expect(names(result)).toEqual(names(POOL))
    // A literal matching no tool is not a wildcard — no stale warning either
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('warns when a wildcard matches no tools in the pool it is applied to', () => {
    const result = applyDisallowedTools(POOL, ['mcp__ghost__*'])
    expect(names(result)).toEqual(names(POOL))
    const warns = vi.mocked(console.warn).mock.calls.map((c) => String(c[0]))
    expect(warns.some((w) => w.includes('disallowedTools') && w.includes('mcp__ghost__*'))).toBe(
      true,
    )
  })
})

describe('filterTools composition (compat)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('applies allow first, then deny (deny wins)', () => {
    const result = filterTools(
      POOL,
      ['mcp__utilities__*', 'mcp__knowledge__*'],
      ['mcp__utilities__convert_units'],
    )
    expect(names(result)).toEqual([
      'mcp__utilities__get_temperature',
      'mcp__knowledge__knowledge_search',
    ])
  })

  it('warns when an allowed wildcard matches nothing (stale pattern)', () => {
    const result = filterTools(POOL, ['mcp__utilities__*', 'mcp__ghost__*'])
    expect(names(result)).toContain('mcp__utilities__get_temperature')
    const warns = vi.mocked(console.warn).mock.calls.map((c) => String(c[0]))
    expect(warns.some((w) => w.includes('mcp__ghost__*') && w.includes('matches no tools'))).toBe(
      true,
    )
    expect(warns.some((w) => w.includes('mcp__utilities__*'))).toBe(false)
  })

  it('deny diagnostics run against the ORIGINAL input — no false stale for allow-removed tools (review round 2)', () => {
    // The allow-list keeps only base tools, so the MCP deny wildcard would
    // see an empty match set if diagnostics ran on the post-allow pool.
    // It must NOT warn: the MCP tools exist in the original input.
    const result = filterTools(POOL, ['Read', 'Write', 'Bash'], ['mcp__utilities__*'])
    expect(names(result)).toEqual(['Read', 'Write', 'Bash'])
    expect(console.warn).not.toHaveBeenCalled()
  })
})

describe('applyAllowedTools zero-match diagnostics (review round 1)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('scope-accurate warning: mentions built-in scope and the MCP/custom bypass', () => {
    const result = applyAllowedTools(POOL, ['Nonexistent1', 'Nonexistent2'])
    expect(result).toEqual([])
    const warns = vi.mocked(console.warn).mock.calls.map((c) => String(c[0]))
    expect(
      warns.some(
        (w) =>
          w.includes('matched none of the 7 built-in tools') &&
          w.includes('built-in tools only') &&
          w.includes('bypass'),
      ),
    ).toBe(true)
  })

  it('a wildcard matching to zero total also warns both stale and zero-match', () => {
    const empty = applyAllowedTools(POOL, ['mcp__ghost__*'])
    expect(empty).toEqual([])
    const warns = vi.mocked(console.warn).mock.calls.map((c) => String(c[0]))
    expect(warns.some((w) => w.includes('mcp__ghost__*'))).toBe(true)
    expect(warns.some((w) => w.includes('matched none of the 7'))).toBe(true)
  })
})

describe('dead-wildcard diagnostics reach injected sink (#78)', () => {
  it('applyAllowedTools dead wildcard warn routed byte-identical', () => {
    const events: Array<{ level: string; msg: string }> = []
    const sink = {
      debug: () => {}, trace: () => {},
      warn: (msg: string) => events.push({ level: 'warn', msg }),
      error: (msg: string) => events.push({ level: 'error', msg }),
      child: () => sink,
    }
    applyAllowedTools([tool('Read')], ['Nope*'], sink as any)
    expect(events[0].msg).toContain('[tools] allowedTools entry "Nope*" matches no tools')
    expect(events[0].level).toBe('warn')
  })
})

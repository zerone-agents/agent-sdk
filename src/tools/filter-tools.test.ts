import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { filterTools } from './index.js'
import type { ToolDefinition } from '../types.js'

/**
 * Regression coverage for issue #64: trailing-* wildcard support and
 * diagnostics in filterTools.
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
].map(Object.freeze)

function names(tools: ToolDefinition[]): string[] {
  return tools.map((t) => t.name)
}

describe('filterTools wildcard matching (issue #64)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('admits every tool under a trailing-* prefix in allowedTools', () => {
    const result = filterTools(POOL, ['mcp__utilities__*'])
    expect(names(result)).toEqual([
      'mcp__utilities__get_temperature',
      'mcp__utilities__convert_units',
    ])
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('supports mixed exact + wildcard entries', () => {
    const result = filterTools(POOL, ['Read', 'mcp__knowledge__*'])
    expect(names(result)).toEqual(['Read', 'mcp__knowledge__knowledge_search'])
  })

  it('removes every tool under a trailing-* prefix in disallowedTools', () => {
    const result = filterTools(POOL, undefined, ['mcp__utilities__*'])
    expect(names(result)).toEqual(names(POOL).filter((n) => !n.startsWith('mcp__utilities__')))
  })

  it('combines an allowed wildcard with a disallowed wildcard', () => {
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

  it("a bare '*' allows everything", () => {
    const result = filterTools(POOL, ['*'])
    expect(names(result)).toEqual(names(POOL))
  })

  it('exact-name entries behave exactly as before (regression)', () => {
    const result = filterTools(POOL, ['Read', 'Bash'])
    expect(names(result)).toEqual(['Read', 'Bash'])
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('prefix must match at the entry boundary — mcp__util* does not admit mcp__utilities__*', () => {
    // trailing-* is plain startsWith: 'mcp__utilities__get_temperature'.startsWith('mcp__util')
    // is TRUE, so a shorter prefix still matches. What must NOT happen is a
    // MID-STRING '*' or a non-suffix '*' being treated as a wildcard.
    const result = filterTools(POOL, ['mcp*search']) // '*' not trailing → exact literal
    expect(result).toEqual([])
  })
})

describe('filterTools diagnostics (issue #64)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('warns when an allowedTools wildcard matches no tools (stale pattern)', () => {
    const result = filterTools(POOL, ['mcp__utilities__*', 'mcp__ghost__*'])
    // 'mcp__utilities__*' still matched — result is not empty
    expect(names(result)).toContain('mcp__utilities__get_temperature')
    const warns = vi.mocked(console.warn).mock.calls.map((c) => String(c[0]))
    expect(warns.some((w) => w.includes('mcp__ghost__*') && w.includes('matches no tools'))).toBe(
      true,
    )
    expect(warns.some((w) => w.includes('mcp__utilities__*'))).toBe(false)
  })

  it('warns loudly when a plain allow-list strips every tool', () => {
    const result = filterTools(POOL, ['mcp__utilities__*']) // matches, sanity guard
    expect(result.length).toBeGreaterThan(0)

    vi.mocked(console.warn).mockClear()
    const empty = filterTools(POOL, ['Nonexistent1', 'Nonexistent2'])
    expect(empty).toEqual([])
    const warns = vi.mocked(console.warn).mock.calls.map((c) => String(c[0]))
    expect(
      warns.some(
        (w) => w.includes('matched none of the 7 available tools') && w.includes('no tools'),
      ),
    ).toBe(true)
  })

  it('an allow-list matching via wildcard to zero total also warns loudly', () => {
    const empty = filterTools(POOL, ['mcp__ghost__*'])
    expect(empty).toEqual([])
    const warns = vi.mocked(console.warn).mock.calls.map((c) => String(c[0]))
    // stale-wildcard warning AND the zero-match warning
    expect(warns.some((w) => w.includes('mcp__ghost__*'))).toBe(true)
    expect(warns.some((w) => w.includes('matched none of the 7'))).toBe(true)
  })

  it('warns when a disallowedTools wildcard matches no tools', () => {
    const result = filterTools(POOL, undefined, ['mcp__ghost__*'])
    expect(names(result)).toEqual(names(POOL)) // nothing removed
    const warns = vi.mocked(console.warn).mock.calls.map((c) => String(c[0]))
    expect(warns.some((w) => w.includes('disallowedTools') && w.includes('mcp__ghost__*'))).toBe(
      true,
    )
  })

  it('no warnings on healthy configurations', () => {
    filterTools(POOL, ['mcp__utilities__*'], ['Bash'])
    expect(console.warn).not.toHaveBeenCalled()
  })
})

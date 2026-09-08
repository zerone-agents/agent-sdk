import { describe, expect, it } from 'vitest'
import {
  escapeMemoryXml,
  MEMORY_CONTEXT_PREAMBLE,
  renderMemoryContext,
} from './render.js'
import { DEFAULT_MEMORY_BUDGETS } from './types.js'
import type { MemoryRecord } from './types.js'

function rec(partial: Partial<MemoryRecord> & { id: string; content: string }): MemoryRecord {
  return {
    scope: 'global', workspaceId: null, importance: 50, status: 'active',
    revision: 1, createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z', deletedAt: null, ...partial,
  }
}

const budgets = { ...DEFAULT_MEMORY_BUDGETS, globalChars: 10, userChars: 5, workspaceChars: 5 }

describe('escapeMemoryXml', () => {
  it('escapes all five structural characters', () => {
    expect(escapeMemoryXml(`a & b <c> "d" 'e'`)).toBe('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;')
  })
})

describe('renderMemoryContext', () => {
  it('returns empty string when every applicable scope is empty', () => {
    expect(renderMemoryContext({ global: [], user: [], workspace: null, budgets })).toBe('')
    expect(renderMemoryContext({ global: [], user: [], workspace: [], budgets })).toBe('')
  })

  it('renders sections in global → user → workspace order with preamble and budgets', () => {
    const out = renderMemoryContext({
      global: [rec({ id: 'g1', content: 'aaaa', importance: 75, scope: 'global' })],
      user: [rec({ id: 'u1', content: 'bb', importance: 25, scope: 'user' })],
      workspace: [rec({ id: 'w1', content: 'cc', importance: 100, scope: 'workspace', workspaceId: 'ws1' })],
      budgets,
    })
    expect(out.startsWith(MEMORY_CONTEXT_PREAMBLE + '\n\n<memories>')).toBe(true)
    expect(out.indexOf('<global_memory')).toBeLessThan(out.indexOf('<user_profile'))
    expect(out.indexOf('<user_profile')).toBeLessThan(out.indexOf('<workspace_memory'))
    // 4 of 10 chars used in global → 40%
    expect(out).toContain('<global_memory usage="40%" chars="4/10">')
    expect(out).toContain('<record importance="high">aaaa</record>')
    expect(out).toContain('<record importance="never_forget">cc</record>')
    expect(out).not.toContain('g1') // no record IDs in prompt context
    expect(out.trimEnd().endsWith('</memories>')).toBe(true)
  })

  it('omits the workspace section when no workspace is bound', () => {
    const out = renderMemoryContext({
      global: [rec({ id: 'g1', content: 'aa', scope: 'global' })],
      user: [], workspace: null, budgets,
    })
    expect(out).not.toContain('workspace_memory')
  })

  it('sorts records by importance desc, updatedAt desc, id asc; skips overflow and continues', () => {
    // budget 10: big(6, high) + small(4, low) fit; mid(5, medium) is skipped, small still selected.
    const out = renderMemoryContext({
      global: [
        rec({ id: 'big', content: 'x'.repeat(6), importance: 75 }),
        rec({ id: 'mid', content: 'y'.repeat(5), importance: 50 }),
        rec({ id: 'small', content: 'z'.repeat(4), importance: 25 }),
      ],
      user: [], workspace: null, budgets,
    })
    expect(out).toContain('x'.repeat(6))
    expect(out).not.toContain('y'.repeat(5))
    expect(out).toContain('z'.repeat(4))
    expect(out).toContain('chars="10/10"')
  })

  it('XML-escapes record content', () => {
    const out = renderMemoryContext({
      global: [rec({ id: 'g1', content: '<inject> & "quote"', scope: 'global' })],
      user: [], workspace: null,
      budgets: { ...budgets, globalChars: 100 },
    })
    expect(out).toContain('&lt;inject&gt; &amp; &quot;quote&quot;')
    expect(out).not.toContain('<inject>')
  })
})
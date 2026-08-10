import { describe, it, expect } from 'vitest'
import { replace } from './edit-replacers.js'

describe('replace()', () => {
  describe('exact match', () => {
    it('matches exact string', () => {
      const result = replace('hello world', 'world', 'there', false)
      expect(result).toEqual({ content: 'hello there' })
    })

    it('rejects multiple matches without replaceAll', () => {
      const result = replace('foo bar foo', 'foo', 'baz', false)
      expect('error' in result).toBe(true)
      expect((result as any).error).toContain('not unique')
    })

    it('replaces all with replaceAll', () => {
      const result = replace('foo bar foo', 'foo', 'baz', true)
      expect(result).toEqual({ content: 'baz bar baz' })
    })
  })

  describe('line-trim match', () => {
    it('matches with trailing whitespace difference', () => {
      const content = '  const x = 1  \n  const y = 2'
      const oldString = '  const x = 1\n  const y = 2'
      const result = replace(content, oldString, 'REPLACED', false)
      expect('content' in result).toBe(true)
      expect((result as any).content).toContain('REPLACED')
    })
  })

  describe('indent-normalize match', () => {
    it('matches with different indentation level', () => {
      const content = '    if (x) {\n      foo()\n    }'
      const oldString = 'if (x) {\n  foo()\n}'
      const result = replace(content, oldString, 'REPLACED', false)
      expect('content' in result).toBe(true)
      expect((result as any).content).toContain('REPLACED')
    })
  })

  describe('whitespace-fold match', () => {
    it('matches when internal spaces differ in count', () => {
      const content = 'const x  =  1\nconst y = 2'
      const oldString = 'const x = 1\nconst y = 2'
      const result = replace(content, oldString, 'REPLACED', false)
      expect('content' in result).toBe(true)
      expect((result as any).content).toContain('REPLACED')
    })

    it('matches when tabs and spaces are mixed', () => {
      const content = 'if (a) {  \t foo()\t }'
      const oldString = 'if (a) { foo() }'
      const result = replace(content, oldString, 'REPLACED', false)
      expect('content' in result).toBe(true)
      expect((result as any).content).toContain('REPLACED')
    })

    it('replaces the exact matched span, preserving original content elsewhere', () => {
      const content = 'a = 1\nb  =  2\nc = 3'
      const result = replace(content, 'b = 2', 'B = 20', false)
      expect('content' in result).toBe(true)
      expect((result as any).content).toBe('a = 1\nB = 20\nc = 3')
    })
  })

  describe('escape-normalize match', () => {
    it('matches literal \\n as newline', () => {
      const content = 'line1\nline2'
      const oldString = 'line1\\nline2'
      const result = replace(content, oldString, 'REPLACED', false)
      expect('content' in result).toBe(true)
      expect((result as any).content).toBe('REPLACED')
    })
  })

  describe('whole-trim match', () => {
    it('matches with extra leading/trailing whitespace', () => {
      const content = 'function foo() {\n  return 1\n}'
      const oldString = '  function foo() {\n    return 1\n  }  '
      const result = replace(content, oldString, 'REPLACED', false)
      expect('content' in result).toBe(true)
    })
  })

  describe('failure modes', () => {
    it('returns not-found error when nothing matches', () => {
      const result = replace('hello world', 'xyz', 'abc', false)
      expect('error' in result).toBe(true)
      expect((result as any).notFound).toBe(true)
    })

    it('returns not-unique error when ambiguous at all levels', () => {
      const content = '  a = 1\n  a = 1'
      const oldString = 'a = 1'
      const result = replace(content, oldString, 'b = 2', false)
      expect('error' in result).toBe(true)
      expect((result as any).notFound).toBe(false)
    })
  })
})

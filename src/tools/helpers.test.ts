import { describe, it, expect } from 'vitest'
import { truncateForCatalog } from './helpers.js'

describe('truncateForCatalog', () => {
  it('returns empty string for empty input', () => {
    expect(truncateForCatalog('')).toBe('')
  })

  it('returns text unchanged when length <= 200', () => {
    const short = 'a'.repeat(100)
    expect(truncateForCatalog(short)).toBe(short)
  })

  it('returns text unchanged when length is exactly 200', () => {
    const exact = 'a'.repeat(200)
    expect(truncateForCatalog(exact)).toBe(exact)
  })

  it('truncates and appends ...(more) when length is 201', () => {
    const long = 'a'.repeat(201)
    expect(truncateForCatalog(long)).toBe('a'.repeat(200) + '...(more)')
  })

  it('truncates and appends ...(more) for very long text', () => {
    const long = 'a'.repeat(500)
    expect(truncateForCatalog(long)).toBe('a'.repeat(200) + '...(more)')
  })

  it('respects custom maxLen', () => {
    expect(truncateForCatalog('abcdef', 3)).toBe('abc...(more)')
    expect(truncateForCatalog('abc', 3)).toBe('abc')
  })
})

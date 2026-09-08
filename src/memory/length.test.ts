import { describe, expect, it } from 'vitest'
import { countMemoryChars } from './length.js'

describe('countMemoryChars (weighted capacity model, review P2-5)', () => {
  it('ASCII counts 1 per code point', () => {
    expect(countMemoryChars('abcdef')).toBe(6)
    expect(countMemoryChars('')).toBe(0)
  })

  it('non-ASCII counts 2 per CODE POINT — surrogate pairs count once', () => {
    expect(countMemoryChars('汉字')).toBe(4)
    expect(countMemoryChars('a汉b')).toBe(4)
    expect(countMemoryChars('😀')).toBe(2) // one code point (surrogate pair), weight 2
    expect(countMemoryChars('😀a')).toBe(3)
  })
})
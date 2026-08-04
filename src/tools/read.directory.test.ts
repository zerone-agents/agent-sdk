import { describe, it, expect } from 'vitest'
import { formatSize } from './read.js'

describe('formatSize', () => {
  it('formats bytes below 1024 as raw B', () => {
    expect(formatSize(0)).toBe('0B')
    expect(formatSize(1)).toBe('1B')
    expect(formatSize(1023)).toBe('1023B')
  })

  it('formats K with one decimal when value < 10', () => {
    expect(formatSize(1024)).toBe('1.0K')        // exactly 1 K
    expect(formatSize(1536)).toBe('1.5K')        // 1.5 K
    expect(formatSize(9216)).toBe('9.0K')        // 9 K exactly
  })

  it('formats K as integer when value >= 10', () => {
    expect(formatSize(10240)).toBe('10K')
    expect(formatSize(12288)).toBe('12K')
    expect(formatSize(1022976)).toBe('999K')     // exactly 999 * 1024, just under 1 M
  })

  it('formats M with one decimal when value < 10', () => {
    expect(formatSize(1048576)).toBe('1.0M')
    expect(formatSize(1572864)).toBe('1.5M')
    expect(formatSize(9437184)).toBe('9.0M')
  })

  it('formats M as integer when value >= 10', () => {
    expect(formatSize(10485760)).toBe('10M')
    expect(formatSize(12582912)).toBe('12M')
  })

  it('formats G with one decimal when value < 10', () => {
    expect(formatSize(1073741824)).toBe('1.0G')
    expect(formatSize(1610612736)).toBe('1.5G')
  })

  it('formats G as integer when value >= 10', () => {
    expect(formatSize(10737418240)).toBe('10G')
  })

  it('caps at T', () => {
    expect(formatSize(1099511627776)).toBe('1.0T')
    expect(formatSize(1649267441664)).toBe('1.5T')
    // Even enormous values stay in T (no P unit)
    expect(formatSize(10995116277760)).toBe('10T')
  })
})

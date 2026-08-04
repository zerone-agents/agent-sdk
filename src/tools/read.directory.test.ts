import { describe, it, expect } from 'vitest'
import { formatSize, formatMtime, formatEntryRow, type DirEntry } from './read.js'

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

describe('formatMtime', () => {
  it('formats as MMM DD HH:mm', () => {
    // Constructing via local components (new Date(Y, M, D, h, m)) makes the test
    // deterministic across host timezones: the brief's expected strings assume the
    // wall-clock values below appear verbatim in the formatted output.
    const jan = new Date(2026, 0, 15, 10, 30)
    const aug = new Date(2026, 7, 4, 14, 2)
    const dec = new Date(2026, 11, 31, 23, 59)

    // Month abbreviation must match English locale regardless of system locale.
    expect(formatMtime(jan)).toBe('Jan 15 10:30')
    expect(formatMtime(aug)).toBe('Aug 04 14:02')
    expect(formatMtime(dec)).toBe('Dec 31 23:59')
  })

  it('zero-pads day to two digits', () => {
    const d = new Date(2026, 2, 1, 5, 7)
    expect(formatMtime(d)).toBe('Mar 01 05:07')
  })

  it('zero-pads hour to two digits', () => {
    const d = new Date(2026, 5, 10, 1, 5)
    expect(formatMtime(d)).toBe('Jun 10 01:05')
  })
})

describe('formatEntryRow', () => {
  const widths = { type: 4, size: 6, mtime: 12 }

  it('formats a regular file row', () => {
    const entry: DirEntry = {
      name: 'package.json',
      type: 'FILE',
      size: 1228,
      mtime: new Date(2026, 7, 4, 9, 15),
      brokenLink: false,
    }
    const row = formatEntryRow(entry, widths)
    // Layout: '  ' + TYPE(padStart 4) + '  ' + SIZE(padStart 6) + '  ' + MTIME(padEnd 12) + '  ' + NAME
    expect(row).toBe('  FILE    1.2K  Aug 04 09:15  package.json')
  })

  it('formats a directory row with trailing slash and - for size', () => {
    const entry: DirEntry = {
      name: 'src',
      type: 'DIR',
      size: null,
      mtime: new Date(2026, 7, 4, 10, 23),
      brokenLink: false,
    }
    const row = formatEntryRow(entry, widths)
    expect(row).toBe('   DIR       -  Aug 04 10:23  src/')
  })

  it('formats a symlink row with -> for size', () => {
    const entry: DirEntry = {
      name: 'npm',
      type: 'LINK',
      size: null,
      mtime: new Date(2026, 7, 4, 10, 23),
      brokenLink: false,
    }
    const row = formatEntryRow(entry, widths)
    expect(row).toBe('  LINK      ->  Aug 04 10:23  npm')
  })

  it('appends (broken link) suffix for broken symlinks', () => {
    const entry: DirEntry = {
      name: 'dangling',
      type: 'LINK',
      size: null,
      mtime: new Date(2026, 7, 4, 10, 23),
      brokenLink: true,
    }
    const row = formatEntryRow(entry, widths)
    expect(row).toBe('  LINK      ->  Aug 04 10:23  dangling (broken link)')
  })

  it('formats OTHER entries (fifo/socket)', () => {
    const entry: DirEntry = {
      name: 'pipe',
      type: 'OTHER',
      size: 0,
      mtime: new Date(2026, 7, 4, 10, 23),
      brokenLink: false,
    }
    const row = formatEntryRow(entry, widths)
    // OTHER has length 5 > widths.type 4; padStart does not truncate.
    expect(row).toBe('  OTHER      0B  Aug 04 10:23  pipe')
  })

  it('right-aligns size column when other rows have larger widths', () => {
    const wideWidths = { type: 4, size: 8, mtime: 12 }
    const entry: DirEntry = {
      name: 'small.txt',
      type: 'FILE',
      size: 12,
      mtime: new Date(2026, 7, 4, 9, 15),
      brokenLink: false,
    }
    const row = formatEntryRow(entry, wideWidths)
    expect(row).toBe('  FILE       12B  Aug 04 09:15  small.txt')
  })
})

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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

import { listDirectory, type ListDirOptions } from './read.js'
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

describe('listDirectory — core', () => {
  let workdir: string

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'readdir-test-'))
  })

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true })
  })

  const defaultOpts: ListDirOptions = { showHidden: false, offset: 0, limit: 200 }

  it('returns a header row plus entries for a basic directory', async () => {
    await writeFile(join(workdir, 'a.txt'), 'hello')
    await mkdir(join(workdir, 'subdir'))

    const result = await listDirectory(workdir, defaultOpts)

    const lines = result.split('\n')
    // Header layout matches formatEntries: '  ' + TYPE(padStart w) + '  ' + SIZE(padStart w) + '  ' + MTIME(padEnd 12) + '  NAME'
    // For this dir, widths = { type: 4, size: 4, mtime: 12 } so MTIME is padded with 7 spaces.
    expect(lines[0]).toBe('  TYPE  SIZE  MTIME         NAME')
    // Find the data rows by name (mtime varies, so we check structure).
    const aLine = lines.find((l) => l.endsWith('a.txt'))
    const subLine = lines.find((l) => l.endsWith('subdir/'))
    expect(aLine).toBeDefined()
    expect(subLine).toBeDefined()
    expect(aLine).toContain('FILE')
    expect(aLine).toContain('5B')            // 'hello' is 5 bytes
    expect(subLine).toContain('DIR')
    expect(subLine).toContain('-')            // size placeholder
  })

  it('hides dotfiles by default', async () => {
    await writeFile(join(workdir, '.env'), 'SECRET=value')
    await writeFile(join(workdir, '.gitignore'), 'node_modules')
    await writeFile(join(workdir, 'visible.ts'), 'export {}')

    const result = await listDirectory(workdir, defaultOpts)

    expect(result).toContain('visible.ts')
    expect(result).not.toContain('.env')
    expect(result).not.toContain('.gitignore')
  })

  it('includes dotfiles when showHidden is true', async () => {
    await writeFile(join(workdir, '.env'), 'SECRET=value')
    await writeFile(join(workdir, 'visible.ts'), 'export {}')

    const result = await listDirectory(workdir, { ...defaultOpts, showHidden: true })

    expect(result).toContain('visible.ts')
    expect(result).toContain('.env')
  })

  it('sorts entries case-insensitively by name', async () => {
    await writeFile(join(workdir, 'Zebra.json'), '1')
    await writeFile(join(workdir, 'apple.ts'), '2')
    await writeFile(join(workdir, 'Banana.md'), '3')

    const result = await listDirectory(workdir, defaultOpts)
    const lines = result.split('\n').slice(1)  // drop header

    const names = lines.map((l) => l.split(/\s+/).pop()!)
    expect(names).toEqual(['apple.ts', 'Banana.md', 'Zebra.json'])
  })

  it('sorts entries with leading dots when shown', async () => {
    await writeFile(join(workdir, '.a'), '1')
    await writeFile(join(workdir, 'b'), '2')
    await writeFile(join(workdir, '.c'), '3')

    const result = await listDirectory(workdir, { ...defaultOpts, showHidden: true })
    const lines = result.split('\n').slice(1)
    const names = lines.map((l) => l.split(/\s+/).pop()!)
    // Dot-prefixed names sort by their remaining characters, so '.a' < '.c' < 'b'
    expect(names).toEqual(['.a', '.c', 'b'])
  })

  it('returns (empty directory) for an empty dir', async () => {
    const result = await listDirectory(workdir, defaultOpts)
    expect(result).toBe('(empty directory)')
  })

  it('returns (empty directory) when only hidden files exist and showHidden is false', async () => {
    await writeFile(join(workdir, '.hidden'), 'secret')
    const result = await listDirectory(workdir, defaultOpts)
    expect(result).toBe('(empty directory)')
  })

  it('throws EACCES-error-shaped rejection when directory is unreadable', async () => {
    // Skip on Windows — chmod bits don't translate cleanly.
    if (process.platform === 'win32') return

    await mkdir(join(workdir, 'locked'), { mode: 0o600 })
    // Drop read+execute for everyone (and owner too to make readdir fail).
    await import('fs/promises').then((fs) => fs.chmod(join(workdir, 'locked'), 0o000))

    await expect(listDirectory(join(workdir, 'locked'), defaultOpts))
      .rejects.toThrow()
  })
})

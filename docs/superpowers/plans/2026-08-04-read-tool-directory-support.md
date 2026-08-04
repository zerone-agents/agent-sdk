# Read Tool: Directory Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `FileReadTool` so that passing a directory path returns a formatted, single-level listing of its entries instead of an error.

**Architecture:** Add an internal `listDirectory()` helper plus small pure formatting helpers (`formatSize`, `formatMtime`, `formatEntryRow`) to `src/tools/read.ts`. Replace the current `isDirectory()` rejection block with a dispatch to `listDirectory()`. Extend `inputSchema` with one optional boolean (`show_hidden`). All work is localized to `src/tools/read.ts` and a new test file `src/tools/read.directory.test.ts`.

**Tech Stack:** TypeScript (ESM, strict), Node.js `fs/promises`, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-04-read-tool-directory-support-design.md`

## Global Constraints

- Node.js `>= 18.0.0` (no use of APIs newer than that).
- ESM modules — all imports use the `.js` extension even for `.ts` source.
- Use `fs/promises` only — no `fs` sync APIs, no `child_process`.
- `MAX_ENTRIES = 200` hard cap, regardless of caller-supplied `limit`.
- Hidden files (name starts with `.`) excluded by default; opt-in via `show_hidden: true`.
- Sort: name ascending, **case-insensitive** (stable across platforms).
- Output is a single string returned through the same channel as text-file reads.
- `isReadOnly` and `isConcurrencySafe` on `FileReadTool` remain `true`.
- All user-facing footer strings use Chinese: `(还有 N 条未显示 — 请用 Glob 工具或细化路径)` and `(empty directory)` (literal English — kept as-is per spec §5.4).
- Existing file/PDF/image read paths must remain unchanged — regression-free.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/tools/read.ts` | Add `formatSize`, `formatMtime`, `formatEntryRow`, `listDirectory`. Extend `inputSchema` with `show_hidden`. Replace directory-rejection block with dispatch. Update tool `description`. |
| `src/tools/read.directory.test.ts` (new) | Vitest suite covering helpers + end-to-end `FileReadTool.call` with directory paths. |

No changes to `src/tools/index.ts`, `src/tools/types.ts`, or any other tool.

---

## Interfaces

These signatures are the contract between tasks. Implementers must match exactly.

```typescript
// Pure helpers — Task 1 & Task 2
export function formatSize(bytes: number): string
//   0 -> '0B'; 1023 -> '1023B'; 1024 -> '1.0K'; 1536 -> '1.5K';
//   1048576 -> '1.0M'; 12582912 -> '12M'; 1073741824 -> '1.0G'

export function formatMtime(mtime: Date): string
//   Format: 'MMM DD HH:mm' (24h). Examples: new Date('2026-08-04T10:23:00Z') -> 'Aug 04 10:23'

interface DirEntry {
  name: string
  type: 'DIR' | 'FILE' | 'LINK' | 'OTHER'
  size: number | null        // bytes; null for DIR/LINK/broken-link
  mtime: Date
  brokenLink: boolean
}

export function formatEntryRow(entry: DirEntry, widths: { type: number; size: number; mtime: number }): string
//   Produces one aligned row, e.g. '  DIR    -       Aug 04 10:23   src/'

// Task 3+ — directory reader
export interface ListDirOptions {
  showHidden: boolean
  offset: number
  limit: number
}

export async function listDirectory(
  path: string,
  options: ListDirOptions,
): Promise<string>
```

---

### Task 1: Pure helper `formatSize`

**Files:**
- Create: `src/tools/read.directory.test.ts`
- Modify: `src/tools/read.ts` (add helper at module bottom, before `export const FileReadTool`)

**Interfaces:**
- Produces: `formatSize(bytes: number): string`

- [ ] **Step 1: Write the failing test**

Create `src/tools/read.directory.test.ts`:

```typescript
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
    expect(formatSize(1023488)).toBe('999K')     // just under 1 M
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tools/read.directory.test.ts`
Expected: FAIL — `formatSize is not a function` (import error).

- [ ] **Step 3: Write minimal implementation**

In `src/tools/read.ts`, **above** `export const FileReadTool`, add:

```typescript
/**
 * Format a byte count as a human-readable size string.
 *  - < 1024:           raw bytes with 'B' suffix
 *  - < 10 of unit:     one decimal place (e.g. '1.5K')
 *  - >= 10 of unit:    rounded integer (e.g. '12M')
 * Units: B, K, M, G, T. Caps at T (no P or beyond).
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  const units = ['K', 'M', 'G', 'T']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex++
  }
  const formatted = value < 10 ? value.toFixed(1) : Math.round(value).toString()
  return `${formatted}${units[unitIndex]}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tools/read.directory.test.ts`
Expected: PASS — all 8 cases.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS — no errors.

- [ ] **Step 6: Commit**

```bash
git add src/tools/read.ts src/tools/read.directory.test.ts
git commit -m "feat(read): add formatSize helper for directory listing

Pure function for human-readable byte formatting (B/K/M/G/T).
First piece of Read Tool directory support."
```

---

### Task 2: `formatMtime` and `formatEntryRow`

**Files:**
- Modify: `src/tools/read.ts` (add helpers below `formatSize`)
- Modify: `src/tools/read.directory.test.ts` (add new describe blocks)

**Interfaces:**
- Consumes: `formatSize` from Task 1
- Produces: `formatMtime(mtime: Date): string`, `DirEntry` interface, `formatEntryRow(entry, widths): string`

- [ ] **Step 1: Write the failing tests**

Append to `src/tools/read.directory.test.ts` (after the `formatSize` describe block):

```typescript
import { formatMtime, formatEntryRow, type DirEntry } from './read.js'

describe('formatMtime', () => {
  it('formats as MMM DD HH:mm', () => {
    // Use a date where local timezone effects can be controlled by setting to UTC midnight
    // and checking the format structure. We test month-name mapping directly.
    const jan = new Date('2026-01-15T10:30:00Z')
    const aug = new Date('2026-08-04T14:02:00Z')
    const dec = new Date('2026-12-31T23:59:00Z')

    // Month abbreviation must match English locale regardless of system locale.
    expect(formatMtime(jan)).toMatch(/^Jan 15 \d{2}:30$/)
    expect(formatMtime(aug)).toMatch(/^Aug 04 \d{2}:02$/)
    expect(formatMtime(dec)).toMatch(/^Dec 31 \d{2}:59$/)
  })

  it('zero-pads day to two digits', () => {
    const d = new Date('2026-03-01T05:07:00Z')
    expect(formatMtime(d)).toMatch(/^Mar 01 \d{2}:07$/)
  })

  it('zero-pads hour to two digits', () => {
    const d = new Date('2026-06-10T01:05:00Z')
    expect(formatMtime(d)).toMatch(/^Jun 10 \d{2}:05$/)
  })
})

describe('formatEntryRow', () => {
  const widths = { type: 4, size: 6, mtime: 12 }

  it('formats a regular file row', () => {
    const entry: DirEntry = {
      name: 'package.json',
      type: 'FILE',
      size: 1228,
      mtime: new Date('2026-08-04T09:15:00Z'),
      brokenLink: false,
    }
    const row = formatEntryRow(entry, widths)
    expect(row).toBe('  FILE  1.2K    Aug 04 09:15   package.json')
  })

  it('formats a directory row with trailing slash and - for size', () => {
    const entry: DirEntry = {
      name: 'src',
      type: 'DIR',
      size: null,
      mtime: new Date('2026-08-04T10:23:00Z'),
      brokenLink: false,
    }
    const row = formatEntryRow(entry, widths)
    expect(row).toBe('  DIR   -        Aug 04 10:23   src/')
  })

  it('formats a symlink row with -> for size', () => {
    const entry: DirEntry = {
      name: 'npm',
      type: 'LINK',
      size: null,
      mtime: new Date('2026-08-04T10:23:00Z'),
      brokenLink: false,
    }
    const row = formatEntryRow(entry, widths)
    expect(row).toBe('  LINK  ->       Aug 04 10:23   npm')
  })

  it('appends (broken link) suffix for broken symlinks', () => {
    const entry: DirEntry = {
      name: 'dangling',
      type: 'LINK',
      size: null,
      mtime: new Date('2026-08-04T10:23:00Z'),
      brokenLink: true,
    }
    const row = formatEntryRow(entry, widths)
    expect(row).toBe('  LINK  ->       Aug 04 10:23   dangling (broken link)')
  })

  it('formats OTHER entries (fifo/socket)', () => {
    const entry: DirEntry = {
      name: 'pipe',
      type: 'OTHER',
      size: 0,
      mtime: new Date('2026-08-04T10:23:00Z'),
      brokenLink: false,
    }
    const row = formatEntryRow(entry, widths)
    expect(row).toBe('  OTHER 0B       Aug 04 10:23   pipe')
  })

  it('right-aligns size column when other rows have larger widths', () => {
    const wideWidths = { type: 4, size: 8, mtime: 12 }
    const entry: DirEntry = {
      name: 'small.txt',
      type: 'FILE',
      size: 12,
      mtime: new Date('2026-08-04T09:15:00Z'),
      brokenLink: false,
    }
    const row = formatEntryRow(entry, wideWidths)
    expect(row).toBe('  FILE      12B       Aug 04 09:15   small.txt')
  })
})
```

> **Note on alignment:** The exact spaces in expected strings depend on the
> alignment rules in the implementation below. The implementer must follow
> the alignment spec: TYPE and SIZE columns are **left-padded** to width
> (i.e. right-aligned), MTIME is left-justified to width, NAME has no padding.
> Each column is preceded by exactly 2 spaces.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tools/read.directory.test.ts`
Expected: FAIL — `formatMtime is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `src/tools/read.ts`, **below** `formatSize`, add:

```typescript
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                     'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * Format a Date as 'MMM DD HH:mm' (24h, English month abbreviations).
 * Day and hour are zero-padded to two digits.
 */
export function formatMtime(mtime: Date): string {
  const month = MONTH_NAMES[mtime.getMonth()]
  const day = String(mtime.getDate()).padStart(2, '0')
  const hour = String(mtime.getHours()).padStart(2, '0')
  const minute = String(mtime.getMinutes()).padStart(2, '0')
  return `${month} ${day} ${hour}:${minute}`
}

/**
 * One directory entry, normalized for formatting.
 * - size is null for directories and symlinks (broken or not).
 * - brokenLink is only true when type === 'LINK' and stat() failed.
 */
export interface DirEntry {
  name: string
  type: 'DIR' | 'FILE' | 'LINK' | 'OTHER'
  size: number | null
  mtime: Date
  brokenLink: boolean
}

/**
 * Format a single DirEntry as one aligned row.
 * Layout: 2sp + TYPE(right-aligned to width) + 2sp + SIZE(right-aligned) + 2sp + MTIME(left-justified) + 2sp + NAME
 * Directories get trailing '/', symlinks get '->' in SIZE, broken links get ' (broken link)' suffix.
 */
export function formatEntryRow(
  entry: DirEntry,
  widths: { type: number; size: number; mtime: number },
): string {
  const typeStr = entry.type.padStart(widths.type)
  let sizeStr: string
  if (entry.type === 'DIR') sizeStr = '-'
  else if (entry.type === 'LINK') sizeStr = '->'
  else sizeStr = formatSize(entry.size ?? 0)
  sizeStr = sizeStr.padStart(widths.size)
  const mtimeStr = formatMtime(entry.mtime).padEnd(widths.mtime)
  let name = entry.name
  if (entry.type === 'DIR') name += '/'
  if (entry.brokenLink) name += ' (broken link)'
  return `  ${typeStr}  ${sizeStr}  ${mtimeStr}  ${name}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tools/read.directory.test.ts`
Expected: PASS — all `formatMtime` and `formatEntryRow` cases green.

> If `OTHER 0B` test fails due to spacing, double-check `padStart` widths.
> With `widths.size = 6`: `'0B'.padStart(6)` = `'    0B'`. Total row:
> `'  OTHER  ' + '    0B' + '  ' + 'Aug 04 10:23' + '  ' + 'pipe'`.
> Adjust test expectation only if the implementer's chosen alignment diverges
> and you've decided to update both consistently.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tools/read.ts src/tools/read.directory.test.ts
git commit -m "feat(read): add formatMtime and formatEntryRow helpers

Pure alignment helpers for directory listing rows."
```

---

### Task 3: `listDirectory` core (read + filter + sort + stat)

**Files:**
- Modify: `src/tools/read.ts` (add `listDirectory` below `formatEntryRow`)
- Modify: `src/tools/read.directory.test.ts` (new describe block for `listDirectory`)

**Interfaces:**
- Consumes: `formatEntryRow`, `DirEntry` from Task 2
- Produces: `ListDirOptions` interface, `listDirectory(path, options)` function

**Scope of this task:** Basic happy-path listing — read entries, filter hidden, sort, stat each, format, return string. **No pagination, no truncation, no symlinks** (defaults only). Tests cover: hidden filter, sort order, basic formatting, empty dir, no-permission directory. Subsequent tasks add pagination + symlinks.

- [ ] **Step 1: Write the failing tests**

Append to `src/tools/read.directory.test.ts`:

```typescript
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
    expect(lines[0]).toBe('  TYPE  SIZE  MTIME        NAME')
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tools/read.directory.test.ts`
Expected: FAIL — `listDirectory is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `src/tools/read.ts`, add `ListDirOptions` and `listDirectory`:

```typescript
export interface ListDirOptions {
  showHidden: boolean
  offset: number
  limit: number
}

/**
 * List a directory's top-level entries, formatted as an aligned text block.
 * Behavior:
 *   - Hidden entries (name starts with '.') excluded unless showHidden.
 *   - Sorted by name, case-insensitive.
 *   - Never recursive.
 *   - Pagination via offset/limit, with MAX_ENTRIES hard cap.
 *
 * Throws if the directory cannot be read (ENOENT, EACCES, etc.) — the
 * caller is responsible for catching and converting to tool_error.
 */
export async function listDirectory(
  path: string,
  options: ListDirOptions,
): Promise<string> {
  const MAX_ENTRIES = 200
  const effectiveLimit = Math.min(options.limit, MAX_ENTRIES)

  const dirents = await readdir(path, { withFileTypes: true })

  let names = dirents.map((d) => d.name)
  if (!options.showHidden) {
    names = names.filter((n) => !n.startsWith('.'))
  }

  if (names.length === 0) {
    return '(empty directory)'
  }

  // Build DirEntry for each name. Use lstat first to detect symlinks.
  // Stat failures on individual entries are tolerated (entry skipped).
  const entries: DirEntry[] = []
  for (const name of names) {
    const fullPath = join(path, name)
    let lstatResult: Stats
    try {
      lstatResult = await lstat(fullPath)
    } catch {
      continue  // skip entries we can't even lstat
    }

    let type: DirEntry['type']
    if (lstatResult.isSymbolicLink()) type = 'LINK'
    else if (lstatResult.isDirectory()) type = 'DIR'
    else if (lstatResult.isFile()) type = 'FILE'
    else type = 'OTHER'

    // For symlinks, attempt stat() to detect broken links and to capture
    // target mtime. If stat fails, mark as broken link.
    let size: number | null = null
    let mtime: Date
    let brokenLink = false

    if (type === 'LINK') {
      try {
        const targetStat = await stat(fullPath)
        mtime = targetStat.mtime
        // Size stays null — symlinks display '->' regardless of target.
      } catch {
        brokenLink = true
        mtime = lstatResult.mtime
      }
    } else {
      size = lstatResult.size
      mtime = lstatResult.mtime
    }

    entries.push({ name, type, size, mtime, brokenLink })
  }

  // Sort case-insensitively, stable for cross-platform parity.
  entries.sort((a, b) => {
    const la = a.name.toLowerCase()
    const lb = b.name.toLowerCase()
    if (la < lb) return -1
    if (la > lb) return 1
    return 0
  })

  // Apply pagination. (Footer logic added in Task 4.)
  const total = entries.length
  const sliced = entries.slice(options.offset, options.offset + effectiveLimit)

  return formatEntries(sliced, { offset: options.offset, total, effectiveLimit })
}

/**
 * Format a slice of DirEntries as the final string output, including
 * header row, alignment, and (in Task 4) pagination footer.
 */
function formatEntries(
  entries: DirEntry[],
  pageInfo: { offset: number; total: number; effectiveLimit: number },
): string {
  if (entries.length === 0) {
    // After pagination, no rows left to show. (Not the same as empty dir.)
    return '(no entries in this range)'
  }

  // Compute column widths from the visible rows + the header label.
  const header = { type: 'TYPE', size: 'SIZE', mtime: 'MTIME' }
  const widths = {
    type: Math.max(header.type.length, ...entries.map((e) => e.type.length)),
    size: Math.max(header.size.length, ...entries.map((e) => {
      if (e.type === 'DIR') return 1
      if (e.type === 'LINK') return 2
      return formatSize(e.size ?? 0).length
    })),
    mtime: Math.max(header.mtime.length, 'MMM DD HH:mm'.length),
  }

  const headerRow = `  ${header.type.padStart(widths.type)}  ${header.size.padStart(widths.size)}  ${header.mtime.padEnd(widths.mtime)}  NAME`
  const rows = entries.map((e) => formatEntryRow(e, widths))

  let result = [headerRow, ...rows].join('\n')

  // Pagination footer added in Task 4.
  const shownCount = entries.length
  const remaining = pageInfo.total - pageInfo.offset - shownCount
  if (remaining > 0) {
    result += `\n\n(还有 ${remaining} 条未显示 — 请用 Glob 工具或细化路径)`
  }

  return result
}
```

You also need to add these imports at the top of `read.ts`:

```typescript
import { readdir, lstat, stat } from 'fs/promises'
import { join } from 'path'
// `Stats` type:
import type { Stats } from 'fs'
```

> **Check existing imports:** `read.ts` already imports `readFile, stat` from
> `'fs/promises'` and `resolve, extname, dirname` from `'path'`. You're adding
> `readdir, lstat` to the fs/promises import, adding `join` to the path import,
> and adding a new `import type { Stats } from 'fs'` line. Do not duplicate `stat`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tools/read.directory.test.ts`
Expected: PASS — all `listDirectory — core` cases green.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tools/read.ts src/tools/read.directory.test.ts
git commit -m "feat(read): add listDirectory core implementation

Reads directory entries, filters hidden files, sorts case-insensitively,
stats each entry, and formats as aligned text. Includes pagination footer.
Does not yet wire up to FileReadTool."
```

---

### Task 4: Pagination and truncation behavior

**Files:**
- Modify: `src/tools/read.directory.test.ts` (append new describe block)

**Interfaces:**
- Consumes: `listDirectory` from Task 3 (pagination footer is already implemented there; this task only verifies the behavior with focused tests)

**Scope:** Verify pagination interactions — offset, limit, MAX_ENTRIES cap, footer message format. Implementation already exists from Task 3; this task is purely test coverage that locks the contract.

- [ ] **Step 1: Write the failing tests**

Append to `src/tools/read.directory.test.ts`:

```typescript
describe('listDirectory — pagination and truncation', () => {
  let workdir: string
  let bigDir: string

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'readdir-page-'))
    bigDir = join(workdir, 'big')
    await mkdir(bigDir)
    // Create 250 entries named 000.txt .. 249.txt
    for (let i = 0; i < 250; i++) {
      await writeFile(join(bigDir, String(i).padStart(3, '0') + '.txt'), String(i))
    }
  })

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true })
  })

  it('caps output at MAX_ENTRIES (200) even when caller asks for more', async () => {
    const result = await listDirectory(bigDir, { showHidden: false, offset: 0, limit: 1000 })
    const lines = result.split('\n')
    // 1 header + 200 entries + 1 blank + 1 footer = 203
    expect(lines.length).toBe(203)
    expect(result).toContain('还有 50 条未显示')
  })

  it('returns exactly 200 rows by default', async () => {
    const result = await listDirectory(bigDir, { showHidden: false, offset: 0, limit: 200 })
    const dataLines = result.split('\n').slice(1)  // drop header
    expect(dataLines.length).toBe(201)  // 200 entries + 1 blank line + footer = 201 after header
    expect(result).toContain('还有 50 条未显示')
  })

  it('honors offset to skip the first N entries', async () => {
    const result = await listDirectory(bigDir, { showHidden: false, offset: 200, limit: 200 })
    const lines = result.split('\n').slice(1)
    // Remaining: 250 - 200 = 50 entries, no footer
    expect(lines.length).toBe(50)
    expect(result).not.toContain('还有')
  })

  it('honors a small limit within a page', async () => {
    const result = await listDirectory(bigDir, { showHidden: false, offset: 10, limit: 5 })
    const lines = result.split('\n').slice(1)
    // 5 entries shown, then footer: 250 - 10 - 5 = 235 remaining
    expect(lines.length).toBe(5)
    expect(result).toContain('还有 235 条未显示')
  })

  it('returns no-entries message when offset exceeds total', async () => {
    const result = await listDirectory(bigDir, { showHidden: false, offset: 500, limit: 10 })
    expect(result).toBe('(no entries in this range)')
  })

  it('does not show footer when all entries fit', async () => {
    // Create a small dir with 5 entries
    const small = join(workdir, 'small')
    await mkdir(small)
    for (let i = 0; i < 5; i++) {
      await writeFile(join(small, `f${i}.txt`), 'x')
    }
    const result = await listDirectory(small, { showHidden: false, offset: 0, limit: 200 })
    expect(result).not.toContain('还有')
    const lines = result.split('\n')
    // 1 header + 5 entries
    expect(lines.length).toBe(6)
  })
})
```

- [ ] **Step 2: Run tests to verify they pass (or fix if mismatch)**

Run: `npx vitest run src/tools/read.directory.test.ts`
Expected: All 7 new pagination tests PASS.

> If any fail, the most likely cause is an off-by-one in the footer logic or
> in the expected line count. Re-examine `formatEntries` in `read.ts` and
> the test expectations. Adjust the implementation, not the tests, unless
> the test itself encodes an incorrect contract (in which case update both
> and note why in the commit message).

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: PASS — all existing tests still pass.

- [ ] **Step 4: Commit**

```bash
git add src/tools/read.directory.test.ts
git commit -m "test(read): lock pagination and truncation contract for listDirectory

Verifies MAX_ENTRIES=200 cap, offset, limit, footer message format,
and out-of-range offset behavior."
```

---

### Task 5: Symlink handling (valid + broken)

**Files:**
- Modify: `src/tools/read.directory.test.ts` (append new describe block)

**Interfaces:**
- Consumes: `listDirectory` from Task 3 (symlink logic already implemented; this task is test coverage)

**Scope:** Verify that valid symlinks and broken symlinks are formatted correctly. The implementation already handles them in `listDirectory`; this task locks the contract with focused tests.

- [ ] **Step 1: Write the failing tests**

Append to `src/tools/read.directory.test.ts`:

```typescript
import { symlink } from 'fs/promises'

describe('listDirectory — symlinks', () => {
  let workdir: string

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'readdir-sym-'))
  })

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true })
  })

  it('formats a valid symlink to a file as LINK with -> for size', async () => {
    const target = join(workdir, 'target.txt')
    await writeFile(target, 'hello')
    const link = join(workdir, 'link.txt')
    await symlink(target, link)

    const result = await listDirectory(workdir, { showHidden: false, offset: 0, limit: 200 })
    const lines = result.split('\n')
    const linkLine = lines.find((l) => l.endsWith('link.txt'))
    const targetLine = lines.find((l) => l.endsWith('target.txt'))

    expect(linkLine).toBeDefined()
    expect(targetLine).toBeDefined()
    expect(linkLine).toContain('LINK')
    expect(linkLine).toContain('->')
    expect(linkLine).not.toContain('(broken link)')
    // Target is reported as a regular FILE.
    expect(targetLine).toContain('FILE')
  })

  it('formats a valid symlink to a directory with no trailing slash on link name', async () => {
    const targetDir = join(workdir, 'realdir')
    await mkdir(targetDir)
    const link = join(workdir, 'linkdir')
    await symlink(targetDir, link)

    const result = await listDirectory(workdir, { showHidden: false, offset: 0, limit: 200 })
    const lines = result.split('\n')
    const linkLine = lines.find((l) => l.includes('linkdir'))
    // Symlink-to-dir is still a LINK, not a DIR; no trailing slash.
    expect(linkLine).toContain('LINK')
    expect(linkLine).not.toMatch(/linkdir\/$/)
  })

  it('marks a broken symlink with (broken link) suffix', async () => {
    // Point at a path that does not exist.
    const link = join(workdir, 'dangling')
    await symlink(join(workdir, 'nope'), link)

    const result = await listDirectory(workdir, { showHidden: false, offset: 0, limit: 200 })
    expect(result).toContain('LINK')
    expect(result).toContain('dangling (broken link)')
  })

  it('does not abort the listing when one entry is a broken symlink', async () => {
    await writeFile(join(workdir, 'good.txt'), 'ok')
    await symlink(join(workdir, 'nope'), join(workdir, 'bad'))

    const result = await listDirectory(workdir, { showHidden: false, offset: 0, limit: 200 })
    expect(result).toContain('good.txt')
    expect(result).toContain('bad (broken link)')
  })

  it('reports a symlink-loop as a broken link, listed exactly once', async () => {
    // Create a -> b -> a loop. Both should be detected as broken.
    const a = join(workdir, 'a')
    const b = join(workdir, 'b')
    await symlink(b, a)
    await symlink(a, b)

    const result = await listDirectory(workdir, { showHidden: false, offset: 0, limit: 200 })
    const aMatches = result.split('\n').filter((l) => l.includes('a (broken link)'))
    const bMatches = result.split('\n').filter((l) => l.includes('b (broken link)'))
    expect(aMatches.length).toBe(1)
    expect(bMatches.length).toBe(1)
  })
})
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run src/tools/read.directory.test.ts`
Expected: All 5 symlink tests PASS.

> If symlink creation fails on Windows, skip those tests with
> `(process.platform === 'win32' ? it.skip : it)`. Default privilege settings
> on Windows may prevent unprivileged symlink creation.

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/tools/read.directory.test.ts
git commit -m "test(read): lock symlink contract for listDirectory

Valid symlinks, broken symlinks, symlink-to-dir, and symlink loops."
```

---

### Task 6: Wire `listDirectory` into `FileReadTool`

**Files:**
- Modify: `src/tools/read.ts` (extend `inputSchema`, replace directory-rejection block, update `description`)
- Modify: `src/tools/read.directory.test.ts` (new describe block for end-to-end `FileReadTool.call`)

**Interfaces:**
- Consumes: `listDirectory` from Task 3
- Produces: Updated `FileReadTool` that accepts directory paths

- [ ] **Step 1: Write the failing tests**

Append to `src/tools/read.directory.test.ts`:

```typescript
import { FileReadTool } from './read.js'

describe('FileReadTool.call — directory paths (end-to-end)', () => {
  let workdir: string
  const mockContext = { cwd: '', sessionId: 'test' }

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'read-tool-e2e-'))
    mockContext.cwd = workdir
  })

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true })
  })

  it('returns a directory listing instead of an error', async () => {
    await writeFile(join(workdir, 'a.txt'), 'hi')
    await mkdir(join(workdir, 'sub'))

    const result: any = await FileReadTool.call(
      { file_path: workdir },
      mockContext,
    )

    expect(result.is_error).toBeFalsy()
    expect(typeof result.content).toBe('string')
    expect(result.content).toContain('TYPE')
    expect(result.content).toContain('a.txt')
    expect(result.content).toContain('sub/')
  })

  it('respects show_hidden option', async () => {
    await writeFile(join(workdir, '.env'), 'k=v')
    await writeFile(join(workdir, 'pub.txt'), 'x')

    const hidden: any = await FileReadTool.call(
      { file_path: workdir },
      mockContext,
    )
    expect(hidden.content).not.toContain('.env')
    expect(hidden.content).toContain('pub.txt')

    const shown: any = await FileReadTool.call(
      { file_path: workdir, show_hidden: true },
      mockContext,
    )
    expect(shown.content).toContain('.env')
    expect(shown.content).toContain('pub.txt')
  })

  it('returns is_error=true when directory does not exist', async () => {
    const result: any = await FileReadTool.call(
      { file_path: join(workdir, 'nope') },
      mockContext,
    )
    expect(result.is_error).toBe(true)
    expect(result.content).toContain('not found')
  })

  it('still reads files normally (regression)', async () => {
    const fp = join(workdir, 'plain.txt')
    await writeFile(fp, 'line one\nline two\n')

    const result: any = await FileReadTool.call(
      { file_path: fp },
      mockContext,
    )
    expect(result.is_error).toBeFalsy()
    expect(result.content).toContain('line one')
    expect(result.content).toMatch(/^\s*1\t/s)
  })

  it('honors offset and limit when reading a directory', async () => {
    for (let i = 0; i < 5; i++) {
      await writeFile(join(workdir, `f${i}.txt`), 'x')
    }
    const result: any = await FileReadTool.call(
      { file_path: workdir, offset: 1, limit: 2 },
      mockContext,
    )
    const lines = (result.content as string).split('\n').slice(1)
    expect(lines.length).toBeGreaterThanOrEqual(2)
    expect(result.content).toContain('还有')
  })

  it('caps at MAX_ENTRIES when caller passes a large limit', async () => {
    for (let i = 0; i < 250; i++) {
      await writeFile(join(workdir, `f${String(i).padStart(3, '0')}.txt`), 'x')
    }
    const result: any = await FileReadTool.call(
      { file_path: workdir, limit: 1000 },
      mockContext,
    )
    const dataLines = (result.content as string).split('\n').slice(1)
    // 200 entries + blank + footer = 202
    expect(dataLines.length).toBe(202)
    expect(result.content).toContain('还有 50 条未显示')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tools/read.directory.test.ts`
Expected: FAIL — the first test ("returns a directory listing") fails with
`is_error: true` and content containing "is a directory".

- [ ] **Step 3: Modify `FileReadTool`**

In `src/tools/read.ts`, **edit the `FileReadTool` definition**:

**3a. Update the `description`** to mention directory support:

```typescript
description: 'Read a file or directory from the filesystem. For files: returns content with line numbers; supports text files, images (returns visual content), and PDFs. For directories: returns a formatted listing of top-level entries (type, size, mtime, name).',
```

**3b. Add `show_hidden` to `inputSchema.properties`:**

```typescript
inputSchema: {
  type: 'object',
  properties: {
    file_path: {
      type: 'string',
      description: 'The absolute path to the file or directory to read',
    },
    offset: {
      type: 'number',
      description: 'Line number to start reading from (0-based, files); or number of entries to skip (directories).',
    },
    limit: {
      type: 'number',
      description: 'Maximum number of lines (files) or entries (directories) to read. Capped at 200 for directories.',
    },
    show_hidden: {
      type: 'boolean',
      description: 'When reading a directory, include hidden files (starting with .). Default: false. Ignored for files.',
      default: false,
    },
  },
  required: ['file_path'],
},
```

**3c. Replace the directory-rejection block** in `call()`. Find this exact block:

```typescript
const fileStat = await stat(filePath)
if (fileStat.isDirectory()) {
  return { data: `Error: ${filePath} is a directory, not a file. Use Bash with 'ls' to list directory contents.`, is_error: true }
}
```

Replace with:

```typescript
const fileStat = await stat(filePath)
if (fileStat.isDirectory()) {
  try {
    const listing = await listDirectory(filePath, {
      showHidden: input.show_hidden ?? false,
      offset: input.offset ?? 0,
      limit: input.limit ?? 200,
    })
    return listing
  } catch (err: any) {
    return { data: `Error reading directory: ${err.message}`, is_error: true }
  }
}
```

> `listDirectory` returns a `string`, which is a valid return type for `call`
> (per the union in `defineTool`). The framework wraps it as a non-error
> `tool_result` automatically.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tools/read.directory.test.ts`
Expected: All 6 end-to-end tests PASS.

- [ ] **Step 5: Run the full test suite**

Run: `npx vitest run`
Expected: PASS — no regressions in `read.test.ts` (if it exists), `bash.test.ts`, `edit.test.ts`, or any other test.

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/tools/read.ts src/tools/read.directory.test.ts
git commit -m "feat(read): FileReadTool now lists directory contents

Directory paths return a formatted listing (type/size/mtime/name) instead
of an error. Adds show_hidden option; reuses offset/limit for pagination.
Capped at 200 entries with footer message."
```

---

## Self-Review Notes

**Spec coverage check** (spec § vs. task that implements it):

- §4 Input schema change (`show_hidden`) → Task 6 step 3b
- §5.1 Dispatch (replace rejection) → Task 6 step 3c
- §5.2 Algorithm (read, filter, sort, stat, format) → Task 3
- §5.3 MAX_ENTRIES = 200 → Task 3 implementation + Task 4 verifies
- §5.4 Empty directory → Task 3 (`empty directory` test) + `empty when only hidden` test
- §5.5 isReadOnly/isConcurrencySafe unchanged → Task 6 (no change to those fields — confirmed in step 3)
- §6 Output format (4 columns, header, alignment) → Task 2 (`formatEntryRow`) + Task 3 (`formatEntries` header)
- §6.1 Column definitions → Task 2
- §6.2 Header row always emitted → Task 3 (`formatEntries` always prepends header)
- §6.3 Size formatting → Task 1
- §7 Error cases → Task 3 (EACCES), Task 6 (ENOENT for missing dir), Task 5 (broken symlink)
- §7 Empty dir → Task 3
- §7 Broken symlinks → Task 3 implementation + Task 5 verifies
- §7 Per-entry stat failure → Task 3 (`continue` on lstat failure)
- §7 More than 200 entries → Task 4
- §7 `limit: 1000` capped → Task 4
- §8 Test plan → covered across Tasks 1, 2, 3, 4, 5, 6

**No placeholders.** Every step contains either a verbatim code block or a verbatim shell command.

**Type consistency.** `DirEntry` fields and `formatEntryRow` signature are identical across Task 2 (definition) and Task 3 (consumer). `ListDirOptions` field names match between Task 3 (definition) and Task 6 (caller). `formatEntries` is internal-only.

**Scope.** Single plan, single feature, 6 tasks. No further decomposition needed.

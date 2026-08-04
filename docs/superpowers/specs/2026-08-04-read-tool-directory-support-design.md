# Read Tool: Directory Support

**Date:** 2026-08-04
**Status:** Approved (pending implementation)
**Scope:** `src/tools/read.ts`

---

## 1. Background

The current `FileReadTool` (`src/tools/read.ts`) explicitly rejects directory paths
with the message:

> `Error: ${filePath} is a directory, not a file. Use Bash with 'ls' to list directory contents.`

Users (and the model itself) must therefore switch to the `Bash` tool whenever they
need to inspect a directory's contents. This breaks the natural mental model of
"Read = read this path" and forces an extra tool dispatch.

This spec extends `Read` so that, when the given path is a directory, it returns
a formatted listing of its top-level entries instead of erroring out.

---

## 2. Goals

- Let `Read` accept a directory path and return a structured listing.
- Stay consistent with the existing "single-level, safe, read-only" behavior.
- Keep the change localized to `src/tools/read.ts` — no new tool, no schema break.
- Preserve the existing file-reading code paths unchanged (regression-free).

### Non-Goals (YAGNI)

- ❌ Recursion / `depth` parameter — not needed; user can call `Read` again on
  any subdirectory. Recursion invites token blow-up.
- ❌ Glob filtering — that's `Glob`'s job.
- ❌ File-type filters (only-files / only-dirs).
- ❌ Permissions / owner display (`ls -l` style) — too noisy for the model.
- ❌ `.gitignore`-aware filtering — `show_hidden` is enough.

---

## 3. Approach Chosen

**Extend `FileReadTool` in place.** Alternatives considered:

| Option | Verdict |
|---|---|
| A. Extend `FileReadTool` (chosen) | Matches user intent, no tool-count bloat, single file to change. |
| B. New `ListDirTool` | Adds a 21st tool; forces the model to decide file-vs-dir before calling. |
| C. Wrap `Bash` + `ls` | Cross-platform inconsistency (BSD vs GNU `ls`), subprocess overhead, no format control. |

---

## 4. Input Schema Change

Add a single optional boolean field to `inputSchema.properties`:

```typescript
show_hidden: {
  type: 'boolean',
  description: 'When reading a directory, include hidden files (starting with .). Default: false.',
  default: false,
}
```

`offset` and `limit` are **reused** for directory listings:
- `limit` caps how many entries to return (default still `200`, hard ceiling `MAX_ENTRIES = 200`).
- `offset` skips the first N entries — enables cheap pagination when truncated.

The `file_path` field semantics are unchanged. The `required: ['file_path']` list
is unchanged. Existing callers see no breaking difference.

---

## 5. Runtime Behavior

### 5.1 Dispatch

Replace the current `isDirectory()` rejection block with:

```typescript
if (fileStat.isDirectory()) {
  return listDirectory(filePath, {
    showHidden: input.show_hidden ?? false,
    offset: input.offset ?? 0,
    limit: input.limit ?? 200,
  })
}
```

### 5.2 `listDirectory` Algorithm

1. Call `readdir(path, { withFileTypes: true })`.
2. Filter out entries whose `name` starts with `.` unless `showHidden === true`.
3. For each remaining entry, `stat()` (with `bigint: false`) to obtain `size` and `mtime`.
   - Use `lstat` first to detect symlinks; if `lstat` says symlink but `stat`
     fails, mark it as a broken link.
   - If a per-entry `stat` rejects for any other reason (e.g. EACCES),
     skip that entry silently — do not abort the whole listing.
4. Sort by `name` ascending, case-insensitive (stable for cross-platform parity).
5. Apply `offset` then `limit` slicing.
6. Compute column widths from the visible (post-slice) rows.
7. Format and return.

### 5.3 Hard Ceiling

`MAX_ENTRIES = 200`. Even if the caller passes `limit: 1000`, only 200 rows
are returned. After the rows, append:

```
(还有 N 条未显示 — 请用 Glob 工具或细化路径)
```

where `N = totalAfterHiddenFilter - offset - returnedCount`.

### 5.4 Empty Directory

If (after hidden filtering) the directory contains zero entries, return the
literal string `(empty directory)`.

### 5.5 `isReadOnly` / `isConcurrencySafe`

Both remain `true` — listing is side-effect-free and safe to run in parallel.

---

## 6. Output Format

Single string (same channel as the text-file branch). Compact aligned columns,
4 columns separated by 2+ spaces, column widths sized to the longest cell in
the returned set:

```
  TYPE   SIZE    MTIME              NAME
  DIR    -       Aug 04 10:23       src/
  DIR    -       Aug 04 14:02       dist/
  FILE   1.2K    Aug 04 09:15       package.json
  FILE   12.4K   Aug 03 22:40       README.md
  FILE   2.0K    Aug 04 10:23       tsconfig.json
  LINK   ->      Aug 04 10:23       npm
```

### 6.1 Column Definitions

| Column | Values / Format |
|---|---|
| `TYPE` | `DIR` / `FILE` / `LINK` / `OTHER` (block/char/fifo/socket). 4 chars wide, right-padded. |
| `SIZE` | Human-readable: `B` / `K` / `M` / `G`. 1 decimal place if value < 10 of the unit, otherwise integer. Directories show `-`. Symlinks show `->`. |
| `MTIME` | `MMM DD HH:mm` (24h). Matches `ls -lh` for quick eyeballing. |
| `NAME` | Entry name. **Directories get a trailing `/`.** Broken symlinks get a trailing ` (broken link)`. |

### 6.2 Header Row

The `TYPE   SIZE ... NAME` header is **always emitted**, even for tiny
directories — helps the model parse columns reliably.

### 6.3 Size Formatting Rules

```typescript
function formatSize(bytes: number): string {
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

---

## 7. Error & Edge Cases

| Scenario | Behavior |
|---|---|
| Path does not exist (`ENOENT`) | Existing error message: `Error: File not found: ${filePath}`. (Name kept even for dir paths — backwards compat.) |
| Path is a directory but unreadable (`EACCES`) | Return `{ data: 'Error: ...', is_error: true }`. |
| Directory empty (after hidden filter) | Return literal `(empty directory)`. |
| Symlink target missing | Still listed, with ` (broken link)` suffix. `stat()` failure on a symlink does **not** abort the listing. |
| Per-entry `stat()` failure (non-symlink) | Entry skipped silently. |
| More than 200 entries after filtering | First 200 returned, footer with remaining count appended. |
| Caller passes `limit: 1000` | Capped at 200 silently (no error). |
| Caller passes both `offset` and `limit` | `offset` slices first, then `limit` is applied; footer count reflects post-offset total. |
| Symbolic link loop | `lstat` succeeds, `stat` throws — treated as broken link, listed once. |

---

## 8. Testing Plan

Add test cases to (or create) `src/tools/read.directory.test.ts`:

1. **Hidden files**: directory containing `.env`, `.gitignore`, `package.json`
   - Default call → `.env` and `.gitignore` absent.
   - `show_hidden: true` → all three present.
2. **Sort order**:
   - Mixed case (`Readme.md`, `abc.ts`, `Zebra.json`) → case-insensitive ascending.
   - Numeric (`a1`, `a10`, `a2`) → lexicographic (NOT natural sort) — matches `ls`.
   - Unicode (Chinese filenames) → stable by code point.
3. **Truncation**: build a temp dir with 250 entries
   - Returns exactly 200 rows.
   - Footer reports `还有 50 条未显示`.
   - With `offset: 200`, returns the remaining 50, footer absent.
4. **Pagination interaction**: `offset: 10, limit: 5` on a 100-entry dir → 5 rows,
   footer reports 85 remaining.
5. **Hard ceiling**: `limit: 1000` on a 500-entry dir → still 200 rows.
6. **Symlink**:
   - Valid symlink to a file → listed as `LINK`, `->` in size column.
   - Broken symlink → listed as `LINK`, name suffix ` (broken link)`.
7. **Empty directory** → `(empty directory)`.
8. **Special file types**:
   - FIFO (`mkfifo`) → `OTHER`.
   - Socket (if feasible on test platform) → `OTHER`.
9. **Regression**: existing file-read tests (`read.test.ts` if present) still pass
   unchanged — confirms dispatch logic intact.
10. **No-permission entry**: chmod 000 on one entry → skipped silently, others listed.
11. **No-permission directory**: chmod 000 on the dir itself → `is_error: true`.
12. **Format**: column alignment invariants — captured via snapshot for one
    representative listing.

---

## 9. Files Touched

| File | Change |
|---|---|
| `src/tools/read.ts` | Replace `isDirectory` rejection with dispatch; add `listDirectory`, `formatSize`, `formatRow` helpers; extend `inputSchema`. |
| `src/tools/read.directory.test.ts` | New test file covering all behaviors in §8. |

No changes to `src/tools/index.ts`, types, or any other tool. Existing exports
intact.

---

## 10. Open Items Resolved During Brainstorming

- **Output style**: compact aligned (chosen over table-style and raw-text).
- **Recursion**: none.
- **Hidden files**: hidden by default, opt-in via `show_hidden`.
- **Sort**: name ascending, case-insensitive.
- **Truncation policy**: hard cap at 200 + footer.

---

## 11. Out-of-Scope / Future Hooks

These are explicitly deferred and should only be added if real usage demands:

- `depth` parameter for bounded recursion.
- `.gitignore`-aware filtering.
- Per-file mtime alongside ctime.
- Tree-style output.

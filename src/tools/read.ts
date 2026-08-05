/**
 * FileReadTool - Read file contents with line numbers
 *
 * Handles three paths:
 * 1. Image/PDF → base64 attachment (data URI)
 * 2. Binary → rejection error
 * 3. Text → line-numbered content
 */

import { readFile, stat, readdir, lstat } from 'fs/promises'
import { resolve, extname, join } from 'path'
import { fileURLToPath } from 'url'
import type { Stats } from 'fs'
import { defineTool } from './types.js'

const SAMPLE_BYTES = 4096
const NON_PRINTABLE_THRESHOLD = 0.3
const MAX_LONG_EDGE = 1536

let _sharp: any = undefined
async function getSharp(): Promise<any> {
  if (_sharp === undefined) {
    try {
      _sharp = (await import('sharp')).default
    } catch {
      _sharp = null
    }
  }
  return _sharp
}

const BINARY_EXTENSIONS = new Set([
  'doc', 'docx',
  'xls', 'xlsx',
  'ppt', 'pptx',
  'odt', 'ods', 'odp',
  'rtf',
  'exe', 'dll', 'so', 'dylib', 'wasm',
  'zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar',
  'jar', 'war', 'class',
  'woff', 'woff2', 'ttf', 'eot', 'otf',
  'mp3', 'mp4', 'avi', 'mov', 'mkv', 'flac', 'wav', 'wmv',
  'sqlite', 'db',
  'bin', 'dat', 'obj', 'o', 'a', 'lib',
  'pyc', 'pyo',
])

function startsWith(bytes: Buffer, prefix: number[]): boolean {
  if (bytes.length < prefix.length) return false
  return prefix.every((v, i) => bytes[i] === v)
}

function sniffMime(bytes: Buffer, fallback: string): string {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'image/gif'
  if (startsWith(bytes, [0x42, 0x4d])) return 'image/bmp'
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf'
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
      bytes.length >= 12 &&
      startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])) {
    return 'image/webp'
  }
  return fallback
}

const EXT_MIME_MAP: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
}

function isImageAttachment(mime: string): boolean {
  return mime.startsWith('image/') && mime !== 'image/svg+xml'
}

function getExtension(filePath: string): string {
  return extname(filePath).slice(1).toLowerCase()
}

function isBinaryByExtension(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(getExtension(filePath))
}

function isBinaryByContent(bytes: Buffer): boolean {
  if (bytes.length === 0) return false
  let nonPrintable = 0
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) return true
    if (bytes[i] < 9 || (bytes[i] > 13 && bytes[i] < 32)) {
      nonPrintable++
    }
  }
  return nonPrintable / bytes.length > NON_PRINTABLE_THRESHOLD
}

interface ExtractPdfResult {
  text: string
  pageCount: number
  fieldCount: number
}

export async function extractPdfText(filePath: string): Promise<ExtractPdfResult> {
  let pdfjs: any
  try {
    if (typeof window === 'undefined' && typeof document === 'undefined') {
      pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    } else {
      pdfjs = await import('pdfjs-dist')
    }
  } catch {
    try {
      pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    } catch {
      pdfjs = await import('pdfjs-dist')
    }
  }
  if (!pdfjs) {
    throw new Error('PDF support requires pdfjs-dist. Install it with: npm install pdfjs-dist')
  }

  const data = new Uint8Array(await readFile(filePath))

  let standardFontDataUrl: string
  try {
    const pdfjsPkgUrl = import.meta.resolve('pdfjs-dist/package.json')
    standardFontDataUrl = new URL('./standard_fonts/', pdfjsPkgUrl).href
  } catch (cause) {
    throw new Error(
      'Cannot locate pdfjs-dist/standard_fonts/. If pdfjs-dist is installed ' +
      'this should not happen; if you bundle this SDK (ncc/electron/Next.js), ' +
      'ensure pdfjs-dist assets are traced.',
      { cause },
    )
  }

  const doc = await pdfjs.getDocument({ data, standardFontDataUrl, disableWorker: true }).promise
  const pageCount = doc.numPages

  let fullText = `--- PDF: ${filePath} (${pageCount} page${pageCount !== 1 ? 's' : ''}) ---\n\n`

  for (let i = 1; i <= pageCount; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()

    const lines: string[] = []
    let lastY: number | null = null
    let currentLine = ''
    for (const item of content.items) {
      if (!(item as any).str) continue
      const y = (item as any).transform?.[5]
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) {
        if (currentLine.trim()) lines.push(currentLine.trim())
        currentLine = ''
      }
      currentLine += (item as any).str
      lastY = y ?? lastY
    }
    if (currentLine.trim()) lines.push(currentLine.trim())
    const pageText = lines.join('\n')

    fullText += `=== Page ${i} ===\n${pageText}\n\n`
    page.cleanup()
  }

  let fieldCount = 0
  try {
    const fieldObjects = await doc.getFieldObjects()
    if (fieldObjects && Object.keys(fieldObjects).length > 0) {
      const formFields: Record<string, string> = {}
      for (const [name, field] of Object.entries(fieldObjects)) {
        if (Array.isArray(field)) {
          const values = field
            .map((f: any) => f.value)
            .filter((v: any) => v !== undefined && v !== null && v !== '')
          if (values.length > 0) {
            formFields[name] = values.join(', ')
          }
        } else {
          const value = (field as any)?.value
          if (value !== undefined && value !== null && value !== '') {
            formFields[name] = String(value)
          }
        }
      }

      if (Object.keys(formFields).length > 0) {
        fieldCount = Object.keys(formFields).length
        fullText += `=== Form Fields (${fieldCount}) ===\n`
        for (const [name, value] of Object.entries(formFields)) {
          fullText += `${name}: ${value}\n`
        }
        fullText += '\n'
      }
    }
  } catch {}

  await doc.destroy()

  return { text: fullText.trimEnd(), pageCount, fieldCount }
}

/**
 * Format a byte count as a human-readable size string.
 *  - < 1024:           raw bytes with 'B' suffix
 *  - < 10 of unit:     one decimal place (e.g. '1.5K')
 *  - >= 10 of unit:    rounded integer (e.g. '12M')
 * Units: B, K, M, G, T. Caps at T (no P or beyond).
 *
 * @internal
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

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                     'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * Format a Date as 'MMM DD HH:mm' (24h, English month abbreviations).
 * Day and hour are zero-padded to two digits.
 *
 * @internal
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
 *
 * @internal
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
 *
 * @internal
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

/** @internal */
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
 *
 * @internal
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

  // Apply pagination.
  const total = entries.length
  const sliced = entries.slice(options.offset, options.offset + effectiveLimit)

  return formatEntries(sliced, { offset: options.offset, total, effectiveLimit })
}

/**
 * Format a slice of DirEntries as the final string output, including
 * header row, alignment, and pagination footer.
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

  // Pagination footer.
  const shownCount = entries.length
  const remaining = pageInfo.total - pageInfo.offset - shownCount
  if (remaining > 0) {
    result += `\n\n(还有 ${remaining} 条未显示 — 请用 Glob 工具或细化路径)`
  }

  return result
}

export const FileReadTool = defineTool({
  name: 'Read',
  description: 'Read a file or directory from the filesystem. For files: returns content with line numbers; supports text files, images (returns visual content), and PDFs. For directories: returns a formatted listing of top-level entries (type, size, mtime, name).',
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
  isReadOnly: true,
  isConcurrencySafe: true,
  async call(input, context) {
    const filePath = resolve(context.cwd, input.file_path)

    try {
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

      const ext = getExtension(filePath)
      const fallbackMime = EXT_MIME_MAP[ext] || ''

      let sample: Buffer
      try {
        const handle = await import('fs/promises').then(m => m.open(filePath, 'r'))
        sample = Buffer.alloc(Math.min(SAMPLE_BYTES, fileStat.size))
        await handle.read(sample, 0, sample.length, 0)
        await handle.close()
      } catch {
        sample = Buffer.alloc(0)
      }

      const mime = sniffMime(sample, fallbackMime)

      if (isImageAttachment(mime)) {
        const buffer = await readFile(filePath)
        const sharp = await getSharp()

        let outputBuffer = buffer
        let outputMime = mime

        if (sharp) {
          const metadata = await sharp(buffer).metadata()
          const width = metadata.width || 0
          const height = metadata.height || 0
          const longEdge = Math.max(width, height)
          const isAlreadyJpeg = mime === 'image/jpeg'
          const needsResize = longEdge > MAX_LONG_EDGE

          if (isAlreadyJpeg && !needsResize) {
            outputBuffer = buffer
            outputMime = mime
          } else {
            let pipeline = sharp(buffer).flatten({ background: { r: 255, g: 255, b: 255 } })
            if (needsResize) {
              pipeline = pipeline.resize({ width: MAX_LONG_EDGE, height: MAX_LONG_EDGE, fit: 'inside', withoutEnlargement: true })
            }
            outputBuffer = await pipeline.jpeg({ quality: 85 }).toBuffer()
            outputMime = 'image/jpeg'
          }
        }

        const base64 = outputBuffer.toString('base64')
        return {
          data: [
            { type: 'text' as const, text: `[Image file: ${filePath} (${fileStat.size} bytes, ${mime})]` },
            { type: 'image' as const, source: { type: 'base64' as const, media_type: outputMime as any, data: base64 } },
          ],
        }
      }

      if (mime === 'application/pdf') {
        try {
          const { text } = await extractPdfText(filePath)
          const lines = text.split('\n')
          const offset = input.offset || 0
          const limit = input.limit || 2000
          const selectedLines = lines.slice(offset, offset + limit)

          const numbered = selectedLines.map((line: string, i: number) => {
            const lineNum = offset + i + 1
            return `${lineNum}\t${line}`
          }).join('\n')

          let result = numbered
          if (lines.length > offset + limit) {
            result += `\n\n(${lines.length - offset - limit} more lines not shown)`
          }

          return result || '(empty PDF)'
        } catch (err: any) {
          return {
            data: `Error: ${err.message}`,
            is_error: true,
          }
        }
      }

      if (isBinaryByExtension(filePath) || isBinaryByContent(sample)) {
        return { data: `Cannot read binary file: ${filePath}`, is_error: true }
      }

      const content = await readFile(filePath, 'utf-8')
      const lines = content.split('\n')

      const offset = input.offset || 0
      const limit = input.limit || 2000
      const selectedLines = lines.slice(offset, offset + limit)

      const numbered = selectedLines.map((line: string, i: number) => {
        const lineNum = offset + i + 1
        return `${lineNum}\t${line}`
      }).join('\n')

      let result = numbered
      if (lines.length > offset + limit) {
        result += `\n\n(${lines.length - offset - limit} more lines not shown)`
      }

      return result || '(empty file)'
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return { data: `Error: File not found: ${filePath}`, is_error: true }
      }
      return { data: `Error reading file: ${err.message}`, is_error: true }
    }
  },
})

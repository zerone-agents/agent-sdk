// Plain Node ESM, executed via `node --import tsx run-extract.mjs <pdf-path>`.
// Bypasses vitest's CJS shim so the bug actually reproduces here.
import { extractPdfText } from '../read.ts'

const fixture = process.argv[2]
if (!fixture) {
  console.error('usage: node --import tsx run-extract.mjs <pdf-path>')
  process.exit(2)
}

const result = await extractPdfText(fixture)
console.log(JSON.stringify({ pageCount: result.pageCount, text: result.text }))

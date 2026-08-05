import { describe, it, expect } from 'vitest'
import { spawnSync } from 'child_process'
import { resolve } from 'path'

const FIXTURE = resolve(__dirname, 'test-fixtures/helvetica.pdf')
const RUNNER = resolve(__dirname, 'test-fixtures/run-extract.mjs')

describe('extractPdfText in plain Node ESM', () => {
  it('extracts text from a Helvetica PDF without emitting standardFontDataUrl warning', () => {
    const res = spawnSync('node', ['--import', 'tsx', RUNNER, FIXTURE], {
      encoding: 'utf-8',
      env: { ...process.env, NODE_NO_WARNINGS: '0' },
    })

    // 1. subprocess completed successfully
    expect(res.status).toBe(0)

    // 2. extract the JSON line from stdout (the line that starts with '{').
    //    pdfjs may emit warnings to stdout or stderr depending on version,
    //    so we can't assume stdout is pure JSON.
    const combined = res.stdout + res.stderr
    const jsonLine = res.stdout.split('\n').find(l => l.trim().startsWith('{'))
    expect(jsonLine).toBeDefined()
    const parsed = JSON.parse(jsonLine!)
    expect(parsed.pageCount).toBe(1)
    expect(parsed.text).toContain('Hello PDF standard font')

    // 3. neither stream must contain the standardFontDataUrl warning
    //    (this assertion catches the bug — fails under current code, passes after fix)
    expect(combined).not.toContain('standardFontDataUrl')
    expect(combined).not.toMatch(/Ensure that the .*standardFontDataUrl/i)
  })
})


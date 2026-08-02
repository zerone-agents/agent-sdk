/**
 * Example 28: Edit Tool Features
 *
 * Part 1: Local tests (no LLM) — fuzzy matching, diff metadata, line endings, error messages
 * Part 2: LLM test — let the model use Edit on real code with imperfect old_string
 *
 * Run: npx tsx examples/28-edit-tool-features.ts
 * Part 2 requires: ZERONE_AGENT_API_KEY, ZERONE_AGENT_BASE_URL, ZERONE_AGENT_MODEL
 */

import { FileEditTool } from '../../src/tools/edit.js'
import { mkdtemp, rm, readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const mockContext = { cwd: '', sessionId: 'test' }

function assert(condition: any, message: string) {
  if (!condition) {
    console.error(`  ❌ ${message}`)
    process.exitCode = 1
  } else {
    console.log(`  ✅ ${message}`)
  }
}

async function test(name: string, fn: () => Promise<void>) {
  console.log(`\n--- ${name} ---`)
  await fn()
}

async function main() {
  console.log('=== Example 28: Edit Tool Features ===\n')

  const workdir = await mkdtemp(join(tmpdir(), 'edit-feature-test-'))
  mockContext.cwd = workdir

  await test('exact replacement with diff metadata', async () => {
    const filePath = join(workdir, 'exact.ts')
    await writeFile(filePath, 'line1\nline2\nline3\nline4\nline5\n')

    const result: any = await FileEditTool.call({
      file_path: filePath,
      old_string: 'line3',
      new_string: 'LINE THREE',
    }, mockContext)

    assert(result.is_error !== true, 'edit succeeded')
    assert(result.metadata?.diff, 'diff returned in metadata')
    assert(result.metadata.diff.includes('@@'), 'diff uses unified diff hunk header')
    assert(result.metadata.diff.includes('---'), 'diff has old file header')
    assert(result.metadata.diff.includes('+++'), 'diff has new file header')
    assert(result.metadata.diff.includes('-line3'), 'diff marks deleted line')
    assert(result.metadata.diff.includes('+LINE THREE'), 'diff marks added line')
    assert(result.metadata.additions === 1, 'additions count correct')
    assert(result.metadata.deletions === 1, 'deletions count correct')
    assert(result.content === 'Edit applied successfully.', 'content is minimal for LLM')
  })

  await test('fuzzy: line-trim matching (trailing whitespace)', async () => {
    const filePath = join(workdir, 'line-trim.ts')
    await writeFile(filePath, '  const x = 1   \n  const y = 2\n')

    const result: any = await FileEditTool.call({
      file_path: filePath,
      old_string: '  const x = 1\n  const y = 2',
      new_string: '  const x = 42\n  const y = 99',
    }, mockContext)

    assert(result.is_error !== true, 'fuzzy match succeeded despite trailing whitespace')
    const content = await readFile(filePath, 'utf-8')
    assert(content.includes('42'), 'file updated correctly')
  })

  await test('fuzzy: indentation normalization', async () => {
    const filePath = join(workdir, 'indent.ts')
    await writeFile(filePath, '    if (x) {\n      foo()\n    }\n')

    const result: any = await FileEditTool.call({
      file_path: filePath,
      old_string: 'if (x) {\n  foo()\n}',
      new_string: 'if (x) {\n  bar()\n}',
    }, mockContext)

    assert(result.is_error !== true, 'indent normalization matched')
    const content = await readFile(filePath, 'utf-8')
    assert(content.includes('bar()'), 'file updated with new function call')
  })

  await test('fuzzy: escape character normalization', async () => {
    const filePath = join(workdir, 'escape.txt')
    await writeFile(filePath, 'line1\nline2\nline3\n')

    const result: any = await FileEditTool.call({
      file_path: filePath,
      old_string: 'line1\\nline2',
      new_string: 'replaced',
    }, mockContext)

    assert(result.is_error !== true, 'escape normalization matched')
    const content = await readFile(filePath, 'utf-8')
    assert(content.startsWith('replaced'), 'literal \\n was treated as newline')
  })

  await test('CRLF line ending preservation', async () => {
    const filePath = join(workdir, 'crlf.ts')
    await writeFile(filePath, 'const x = 1\r\nconst y = 2\r\n')

    await FileEditTool.call({
      file_path: filePath,
      old_string: 'const x = 1',
      new_string: 'const x = 42',
    }, mockContext)

    const content = await readFile(filePath, 'utf-8')
    assert(content.includes('\r\n'), 'CRLF preserved')
    assert(!/(?<!\r)\n/.test(content), 'no bare LF introduced')
    assert(content.includes('42'), 'content was updated')
  })

  await test('create new file with empty old_string', async () => {
    const filePath = join(workdir, 'new-file.ts')

    const result: any = await FileEditTool.call({
      file_path: filePath,
      old_string: '',
      new_string: 'export const hello = "world"\n',
    }, mockContext)

    assert(result.content.includes('File created'), 'reports file creation')
    const content = await readFile(filePath, 'utf-8')
    assert(content === 'export const hello = "world"\n', 'new file content correct')
    assert(result.metadata?.diff, 'diff returned for new file')
  })

  await test('replace_all for multiple occurrences', async () => {
    const filePath = join(workdir, 'replace-all.ts')
    await writeFile(filePath, 'foo\nfoo\nfoo\n')

    const result: any = await FileEditTool.call({
      file_path: filePath,
      old_string: 'foo',
      new_string: 'bar',
      replace_all: true,
    }, mockContext)

    assert(result.is_error !== true, 'replace_all succeeded')
    const content = await readFile(filePath, 'utf-8')
    assert(content === 'bar\nbar\nbar\n', 'all occurrences replaced')
  })

  await test('error: old_string not found with actionable message', async () => {
    const filePath = join(workdir, 'not-found.ts')
    await writeFile(filePath, 'hello world\n')

    const result: any = await FileEditTool.call({
      file_path: filePath,
      old_string: 'nonexistent text',
      new_string: 'replacement',
    }, mockContext)

    assert(result.is_error === true, 'returns error')
    assert(result.content.includes('Could not find old_string'), 'error mentions old_string')
    assert(result.content.includes('read the file again'), 'error points to next action')
  })

  await test('error: not unique with replace_all hint', async () => {
    const filePath = join(workdir, 'not-unique.ts')
    await writeFile(filePath, 'foo\nfoo\nfoo\n')

    const result: any = await FileEditTool.call({
      file_path: filePath,
      old_string: 'foo',
      new_string: 'bar',
    }, mockContext)

    assert(result.is_error === true, 'returns error')
    assert(result.content.includes('multiple matches'), 'error mentions multiple matches')
    assert(result.content.includes('replace_all'), 'error suggests replace_all')
  })

  await test('error: file not found with path guidance', async () => {
    const result: any = await FileEditTool.call({
      file_path: join(workdir, 'does-not-exist.ts'),
      old_string: 'x',
      new_string: 'y',
    }, mockContext)

    assert(result.is_error === true, 'returns error')
    assert(result.content.includes('File not found'), 'error mentions file not found')
    assert(result.content.includes('verify the file path'), 'error points to next action')
  })

  await test('diff shows unified format with context', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`)
    const filePath = join(workdir, 'diff-context.ts')
    await writeFile(filePath, lines.join('\n') + '\n')

    const result: any = await FileEditTool.call({
      file_path: filePath,
      old_string: 'line5',
      new_string: 'LINE FIVE',
    }, mockContext)

    const diff = result.metadata?.diff
    assert(diff, 'diff exists')
    assert(diff.includes('@@'), 'diff has unified hunk header')
    assert(diff.includes('line2') || diff.includes('line3'), 'diff has context before (3 lines)')
    assert(diff.includes('line7') || diff.includes('line8'), 'diff has context after (3 lines)')
    assert(diff.includes('-line5'), 'diff has deletion with content')
    assert(diff.includes('+LINE FIVE'), 'diff has addition with content')
    assert(result.metadata.additions === 1, 'additions = 1')
    assert(result.metadata.deletions === 1, 'deletions = 1')

    console.log('\n  Unified diff preview:')
    diff.split('\n').forEach((l: string) => console.log(`    ${l}`))
  })

  await rm(workdir, { recursive: true, force: true })

  // Run LLM test
  await llmTest()
}

/**
 * Part 2: LLM-driven test — the model uses Edit on a real file with potentially
 * imperfect old_string. Verifies fuzzy matching, diff metadata in tool_result events.
 */
async function llmTest() {
  const apiKey = process.env.ZERONE_AGENT_API_KEY
  if (!apiKey) {
    console.log('\n=== LLM Test Skipped (no ZERONE_AGENT_API_KEY) ===')
    return
  }

  console.log('\n=== LLM-Driven Edit Test ===\n')

  const { createAgent } = await import('../src/index.js')
  const workdir = await mkdtemp(join(tmpdir(), 'edit-llm-test-'))

  // Create a sample file for the LLM to edit
  const filePath = join(workdir, 'utils.ts')
  await writeFile(filePath, [
    'export function add(a: number, b: number): number {',
    '  return a + b',
    '}',
    '',
    'export function multiply(a: number, b: number): number {',
    '  return a * b',
    '}',
    '',
    'export function divide(a: number, b: number): number {',
    '  if (b === 0) throw new Error("division by zero")',
    '  return a / b',
    '}',
    '',
    'export const VERSION = "1.0.0"',
    '',
    'export function greet(name: string): string {',
    '  return `Hello, ${name}!`',
    '}',
    '',
  ].join('\n'))

  const agent = createAgent({
    model: process.env.ZERONE_AGENT_MODEL || 'claude-sonnet-4-6',
    agent: { description: 'Edit tool features agent', prompt: { type: 'preset', preset: 'default' }, maxTurns: 10 },
    cwd: workdir,
    apiType: process.env.ZERONE_AGENT_API_TYPE as any,
    apiKey,
    baseURL: process.env.ZERONE_AGENT_BASE_URL,
  })

  const prompt = [
    'I have a file utils.ts. Please make these 3 edits:',
    '1. Change the VERSION from "1.0.0" to "2.0.0"',
    '2. In the divide function, change the error message from "division by zero" to "cannot divide by zero"',
    '3. In the greet function, change the greeting from "Hello" to "Hi"',
    '',
    'Use the Edit tool for each change.',
  ].join('\n')

  console.log(`Prompt: ${prompt.slice(0, 100)}...\n`)

  let editCount = 0
  let lastDiff = ''

  for await (const event of agent.query(prompt)) {
    if (event.type === 'tool_result' && event.result.tool_name === 'Edit') {
      editCount++
      const metadata = (event.result as any).metadata
      if (metadata?.diff) {
        lastDiff = metadata.diff
        console.log(`\n  Edit #${editCount} diff:`)
        metadata.diff.split('\n').forEach((line: string) => console.log(`    ${line}`))
      }
      console.log(`  Edit #${editCount} output: ${event.result.output}`)
    }

    if (event.type === 'assistant' && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === 'text' && block.text.trim()) {
          console.log(`\n[Assistant] ${block.text.slice(0, 200)}`)
        }
      }
    }
  }

  console.log(`\n--- Results ---`)
  console.log(`Edits made: ${editCount}`)

  // Verify final file content
  const finalContent = await readFile(filePath, 'utf-8')
  assert(editCount === 3, `expected 3 edits, got ${editCount}`)
  assert(finalContent.includes('2.0.0'), 'VERSION updated to 2.0.0')
  assert(finalContent.includes('cannot divide by zero'), 'divide error message updated')
  assert(finalContent.includes('Hi,'), 'greet updated to Hi')
  assert(lastDiff.length > 0, 'at least one diff was returned via metadata')

  await agent.close()
  await rm(workdir, { recursive: true, force: true })
  console.log('\n=== LLM Test Done ===')
}

main().catch(console.error)

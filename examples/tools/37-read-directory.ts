/**
 * Example 37: Read Tool — Directory Support
 *
 * Demonstrates the FileReadTool's ability to list directory contents.
 * When file_path points to a directory, Read returns a formatted listing
 * (type/size/mtime/name) instead of erroring.
 *
 * Part 1: Local tests (no LLM) — verify directory-listing behavior directly
 *   - hidden files default off, opt-in via show_hidden
 *   - sort order (case-insensitive)
 *   - pagination via offset/limit with hard cap at MAX_ENTRIES=200
 *   - empty directory returns '(empty directory)'
 *   - symlink formatting (valid + broken)
 *   - regression: file reading still works
 *
 * Part 2: LLM test — let the model explore a directory using Read
 *
 * Run: npx tsx examples/tools/37-read-directory.ts
 * Part 2 requires: ZERONE_AGENT_API_KEY (or ANTHROPIC_API_KEY), optional
 *   ZERONE_AGENT_BASE_URL, ZERONE_AGENT_MODEL, ZERONE_AGENT_API_TYPE
 */

import { FileReadTool } from '../../src/tools/read.js'
import { mkdtemp, rm, writeFile, mkdir, symlink } from 'fs/promises'
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
  console.log('=== Example 37: Read Tool — Directory Support ===\n')

  const workdir = await mkdtemp(join(tmpdir(), 'read-dir-demo-'))
  mockContext.cwd = workdir

  // ---- Fixture: build a small representative project layout ----
  await mkdir(join(workdir, 'src'))
  await mkdir(join(workdir, 'src', 'tools'))
  await mkdir(join(workdir, 'dist'))
  await writeFile(join(workdir, 'package.json'), JSON.stringify({
    name: 'demo-pkg',
    version: '1.0.0',
  }, null, 2))
  await writeFile(join(workdir, 'README.md'), '# Demo\n\nA small fixture project.\n')
  await writeFile(join(workdir, '.env'), 'SECRET=value')
  await writeFile(join(workdir, '.gitignore'), 'node_modules\ndist\n')
  await writeFile(join(workdir, 'src', 'index.ts'), 'export {}\n')
  await writeFile(join(workdir, 'src', 'tools', 'read.ts'), '// placeholder\n')

  await test('listing a directory returns formatted entries', async () => {
    const result: any = await FileReadTool.call({ file_path: workdir }, mockContext)

    assert(result.is_error !== true, 'listing succeeded (not an error)')
    assert(typeof result.content === 'string', 'content is a string')

    const lines = result.content.split('\n')
    assert(lines[0].includes('TYPE') && lines[0].includes('NAME'), 'header row present')

    // Directories present with trailing slash
    assert(result.content.includes('src/'), 'src/ listed with trailing slash')
    assert(result.content.includes('dist/'), 'dist/ listed with trailing slash')

    // Files present with size
    assert(result.content.includes('package.json'), 'package.json listed')
    assert(result.content.includes('README.md'), 'README.md listed')

    // Hidden files excluded by default
    assert(!result.content.includes('.env'), '.env hidden by default')
    assert(!result.content.includes('.gitignore'), '.gitignore hidden by default')

    console.log('\n  Sample listing:')
    result.content.split('\n').slice(0, 6).forEach((l: string) => console.log(`    ${l}`))
  })

  await test('show_hidden=true reveals dotfiles', async () => {
    const result: any = await FileReadTool.call(
      { file_path: workdir, show_hidden: true },
      mockContext,
    )
    assert(result.content.includes('.env'), '.env shown when show_hidden=true')
    assert(result.content.includes('.gitignore'), '.gitignore shown when show_hidden=true')
    assert(result.content.includes('package.json'), 'regular files still listed')
  })

  await test('entries sorted case-insensitively by name', async () => {
    // Build a small dir with mixed-case names.
    const sortDir = join(workdir, 'sort-fixture')
    await mkdir(sortDir)
    await writeFile(join(sortDir, 'Zebra.json'), '1')
    await writeFile(join(sortDir, 'apple.ts'), '2')
    await writeFile(join(sortDir, 'Banana.md'), '3')

    const result: any = await FileReadTool.call({ file_path: sortDir }, mockContext)
    const lines = result.content.split('\n').slice(1) // drop header
    const names = lines.map((l: string) => l.trim().split(/\s+/).pop())
    assert(
      names.join(',') === 'apple.ts,Banana.md,Zebra.json',
      `case-insensitive sort order (got: ${names.join(',')})`,
    )
  })

  await test('offset and limit paginate entries', async () => {
    const pageDir = join(workdir, 'pagination-fixture')
    await mkdir(pageDir)
    for (let i = 0; i < 5; i++) {
      await writeFile(join(pageDir, `f${i}.txt`), 'x')
    }

    const result: any = await FileReadTool.call(
      { file_path: pageDir, offset: 1, limit: 2 },
      mockContext,
    )
    const lines = (result.content as string).split('\n').slice(1)
    assert(lines.length >= 2, `at least 2 entries returned (got ${lines.length})`)
    assert(result.content.includes('还有'), 'footer indicates remaining entries')
  })

  await test('hard cap at MAX_ENTRIES=200 even with large limit', async () => {
    const bigDir = join(workdir, 'big-fixture')
    await mkdir(bigDir)
    for (let i = 0; i < 250; i++) {
      await writeFile(join(bigDir, String(i).padStart(3, '0') + '.txt'), 'x')
    }

    const result: any = await FileReadTool.call(
      { file_path: bigDir, limit: 1000 },
      mockContext,
    )
    const dataLines = (result.content as string).split('\n').slice(1)
    // 200 entries + blank line + footer line = 202
    assert(dataLines.length === 202, `capped at 200 entries (got ${dataLines.length} lines)`)
    assert(result.content.includes('还有 50 条未显示'), 'footer reports 50 hidden entries')
  })

  await test('empty directory returns (empty directory)', async () => {
    const emptyDir = join(workdir, 'empty-fixture')
    await mkdir(emptyDir)

    const result: any = await FileReadTool.call({ file_path: emptyDir }, mockContext)
    assert(result.content === '(empty directory)', `got: ${result.content}`)
  })

  await test('symlinks are formatted correctly (valid + broken)', async () => {
    // Skip on platforms where symlink creation may require privileges.
    const symDir = join(workdir, 'symlink-fixture')
    await mkdir(symDir)
    await writeFile(join(symDir, 'target.txt'), 'hello')
    try {
      await symlink(join(symDir, 'target.txt'), join(symDir, 'good-link'))
      await symlink(join(symDir, 'does-not-exist'), join(symDir, 'bad-link'))
    } catch (err: any) {
      if (err.code === 'EPERM' || err.code === 'EACCES') {
        console.log('  ⚠️ symlink creation not permitted on this platform — skipping')
        return
      }
      throw err
    }

    const result: any = await FileReadTool.call({ file_path: symDir }, mockContext)
    assert(result.content.includes('LINK'), 'symlinks marked as LINK type')
    assert(result.content.includes('->'), 'symlink size column shows ->')
    assert(result.content.includes('good-link'), 'valid symlink listed by name')
    assert(
      result.content.includes('bad-link (broken link)'),
      'broken symlink annotated with (broken link)',
    )
  })

  await test('nonexistent directory returns is_error', async () => {
    const result: any = await FileReadTool.call(
      { file_path: join(workdir, 'nope') },
      mockContext,
    )
    assert(result.is_error === true, 'returns is_error=true')
    assert(result.content.includes('not found'), 'error message mentions "not found"')
  })

  await test('regression: file reading still works unchanged', async () => {
    const filePath = join(workdir, 'package.json')
    const result: any = await FileReadTool.call({ file_path: filePath }, mockContext)
    assert(result.is_error !== true, 'file read succeeded')
    assert(result.content.includes('demo-pkg'), 'file content readable')
    assert(result.content.match(/^\s*1\t/s), 'content has line-number prefix (text path intact)')
  })

  await rm(workdir, { recursive: true, force: true })

  // Run LLM test
  await llmTest()
}

/**
 * Part 2: LLM-driven test — the model uses Read to explore a directory tree
 * it has never seen. Verifies that the model gets the new behavior automatically
 * (no error telling it to switch to Bash), and can navigate via subdirectory reads.
 */
async function llmTest() {
  const apiKey = process.env.ZERONE_AGENT_API_KEY || process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    console.log('\n=== LLM Test Skipped (no ZERONE_AGENT_API_KEY / ANTHROPIC_API_KEY) ===')
    return
  }

  console.log('\n=== LLM-Driven Directory Read Test ===\n')

  const { createAgent } = await import('../../src/index.js')
  const workdir = await mkdtemp(join(tmpdir(), 'read-dir-llm-'))

  // Fixture: a small fake project the model has to explore
  await mkdir(join(workdir, 'src'), { recursive: true })
  await mkdir(join(workdir, 'src', 'components'), { recursive: true })
  await mkdir(join(workdir, 'tests'))
  await writeFile(
    join(workdir, 'package.json'),
    JSON.stringify({ name: 'mystery-app', version: '0.4.2', private: true }, null, 2),
  )
  await writeFile(join(workdir, 'README.md'), '# Mystery App\n\nAwaiting discovery.\n')
  await writeFile(join(workdir, 'src', 'index.ts'), 'export { greet } from "./components/greet.js"\n')
  await writeFile(
    join(workdir, 'src', 'components', 'greet.ts'),
    'export function greet(name: string): string {\n  return `Hello, ${name}!`\n}\n',
  )
  await writeFile(join(workdir, 'tests', 'smoke.test.ts'), 'import { describe, it } from "vitest"\n')

  const agent = createAgent({
    model: process.env.ZERONE_AGENT_MODEL || 'claude-sonnet-4-6',
    agent: {
      description: 'Directory-explorer agent',
      prompt: { type: 'preset', preset: 'default' },
      maxTurns: 10,
    },
    cwd: workdir,
    apiType: process.env.ZERONE_AGENT_API_TYPE as any,
    apiKey,
    baseURL: process.env.ZERONE_AGENT_BASE_URL,
  })

  const prompt = [
    'Explore the current directory using the Read tool only (do NOT use Bash).',
    'Start by reading "." — Read now lists directories instead of erroring.',
    'Then navigate into any subdirectories you find interesting.',
    'When done, answer in 3 short bullets:',
    '  1. The project name and version',
    '  2. How many source files you found',
    '  3. Whether the project has any tests',
  ].join('\n')

  console.log(`Agent prompt:\n${prompt}\n`)

  let readDirCount = 0
  let readFileCount = 0

  for await (const event of agent.query(prompt)) {
    if (event.type === 'tool_result' && event.result.tool_name === 'Read') {
      const output = event.result.output
      // Heuristic: a directory listing contains the TYPE/NAME header row.
      if (output.includes('TYPE') && output.includes('NAME')) {
        readDirCount++
        console.log(`\n  📁 Read(directory) → ${output.split('\n').length} lines`)
        output.split('\n').slice(0, 4).forEach((l: string) => console.log(`    ${l}`))
        if (output.split('\n').length > 4) console.log('    ...')
      } else {
        readFileCount++
        const preview = output.length > 80 ? output.slice(0, 80) + '...' : output
        console.log(`\n  📄 Read(file) → ${preview.replace(/\n/g, ' | ')}`)
      }
    }

    if (event.type === 'assistant' && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === 'text' && block.text.trim()) {
          console.log(`\n[Assistant]\n${block.text}`)
        }
      }
    }
  }

  console.log(`\n--- Results ---`)
  console.log(`Read(directory) calls: ${readDirCount}`)
  console.log(`Read(file) calls:      ${readFileCount}`)
  assert(readDirCount >= 1, 'model used Read on at least one directory')
  assert(readDirCount + readFileCount >= 2, 'model made multiple Read calls')

  await agent.close()
  await rm(workdir, { recursive: true, force: true })
  console.log('\n=== LLM Test Done ===')
}

main().catch(console.error)

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { FileEditTool } from './edit.js'

describe('FileEditTool', () => {
  let workdir: string
  const mockContext = { cwd: '', sessionId: 'test' }

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'edit-test-'))
    mockContext.cwd = workdir
  })

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true })
  })

  it('performs exact replacement', async () => {
    const filePath = join(workdir, 'test.ts')
    await writeFile(filePath, 'const x = 1\nconst y = 2\n')

    const result: any = await FileEditTool.call({
      file_path: filePath,
      old_string: 'const x = 1',
      new_string: 'const x = 42',
    }, mockContext)

    const content = await readFile(filePath, 'utf-8')
    expect(content).toBe('const x = 42\nconst y = 2\n')
    expect(result.metadata).toBeDefined()
  })

  it('creates new file when old_string is empty', async () => {
    const filePath = join(workdir, 'new.ts')

    const result: any = await FileEditTool.call({
      file_path: filePath,
      old_string: '',
      new_string: 'export const hello = "world"',
    }, mockContext)

    const content = await readFile(filePath, 'utf-8')
    expect(content).toBe('export const hello = "world"')
    expect(result.content).toContain('File created')
    expect(result.metadata.additions).toBe(1)
    expect(result.metadata.deletions).toBe(0)
  })

  it('matches with trailing whitespace difference (line-trim)', async () => {
    const filePath = join(workdir, 'test.ts')
    await writeFile(filePath, '  const x = 1   \n  const y = 2\n')

    const result: any = await FileEditTool.call({
      file_path: filePath,
      old_string: '  const x = 1\n  const y = 2',
      new_string: 'REPLACED',
    }, mockContext)

    const content = await readFile(filePath, 'utf-8')
    expect(content).toContain('REPLACED')
    expect(result.is_error).toBeFalsy()
  })

  it('matches with different indentation level (indent-normalize)', async () => {
    const filePath = join(workdir, 'test.ts')
    await writeFile(filePath, '    if (x) {\n      foo()\n    }\n')

    const result: any = await FileEditTool.call({
      file_path: filePath,
      old_string: 'if (x) {\n  foo()\n}',
      new_string: 'if (x) {\n  bar()\n}',
    }, mockContext)

    const content = await readFile(filePath, 'utf-8')
    expect(content).toContain('bar()')
    expect(result.is_error).toBeFalsy()
  })

  it('matches literal \\n as newline (escape-normalize)', async () => {
    const filePath = join(workdir, 'test.txt')
    await writeFile(filePath, 'line1\nline2\n')

    const result: any = await FileEditTool.call({
      file_path: filePath,
      old_string: 'line1\\nline2',
      new_string: 'replaced',
    }, mockContext)

    const content = await readFile(filePath, 'utf-8')
    expect(content).toContain('replaced')
    expect(result.is_error).toBeFalsy()
  })

  it('preserves CRLF line endings', async () => {
    const filePath = join(workdir, 'crlf.ts')
    await writeFile(filePath, 'const x = 1\r\nconst y = 2\r\n')

    await FileEditTool.call({
      file_path: filePath,
      old_string: 'const x = 1',
      new_string: 'const x = 42',
    }, mockContext)

    const content = await readFile(filePath, 'utf-8')
    expect(content).toContain('\r\n')
    expect(content).not.toMatch(/(?<!\r)\n/)
  })

  it('returns unified diff in metadata', async () => {
    const filePath = join(workdir, 'test.ts')
    await writeFile(filePath, 'line1\nline2\nline3\nline4\nline5\n')

    const result: any = await FileEditTool.call({
      file_path: filePath,
      old_string: 'line3',
      new_string: 'LINE THREE',
    }, mockContext)

    expect(result.metadata).toBeDefined()
    expect(result.metadata.diff).toContain('@@')
    expect(result.metadata.diff).toContain('---')
    expect(result.metadata.diff).toContain('+++')
    expect(result.metadata.diff).toContain('-line3')
    expect(result.metadata.diff).toContain('+LINE THREE')
    expect(result.metadata.diff).toContain('line2')
    expect(result.metadata.diff).toContain('line4')
  })

  it('returns additions and deletions counts in metadata', async () => {
    const filePath = join(workdir, 'counts.ts')
    await writeFile(filePath, 'a\nb\nc\nd\ne\n')

    const result: any = await FileEditTool.call({
      file_path: filePath,
      old_string: 'b\nc\nd',
      new_string: 'B\nC\nD\nE',
    }, mockContext)

    expect(result.metadata.additions).toBe(4)
    expect(result.metadata.deletions).toBe(3)
  })

  it('returns error when old_string not found', async () => {
    const filePath = join(workdir, 'test.ts')
    await writeFile(filePath, 'hello world\n')

    const result: any = await FileEditTool.call({
      file_path: filePath,
      old_string: 'nonexistent',
      new_string: 'replacement',
    }, mockContext)

    expect(result.is_error).toBe(true)
    expect(result.content).toContain('Could not find old_string')
  })

  it('returns error when old_string is not unique', async () => {
    const filePath = join(workdir, 'test.ts')
    await writeFile(filePath, 'foo\nfoo\nfoo\n')

    const result: any = await FileEditTool.call({
      file_path: filePath,
      old_string: 'foo',
      new_string: 'bar',
    }, mockContext)

    expect(result.is_error).toBe(true)
    expect(result.content).toContain('multiple matches')
  })

  it('replaces all with replace_all', async () => {
    const filePath = join(workdir, 'test.ts')
    await writeFile(filePath, 'foo\nfoo\nfoo\n')

    await FileEditTool.call({
      file_path: filePath,
      old_string: 'foo',
      new_string: 'bar',
      replace_all: true,
    }, mockContext)

    const content = await readFile(filePath, 'utf-8')
    expect(content).toBe('bar\nbar\nbar\n')
  })

  it('returns error when file not found', async () => {
    const result: any = await FileEditTool.call({
      file_path: join(workdir, 'nonexistent.ts'),
      old_string: 'x',
      new_string: 'y',
    }, mockContext)

    expect(result.is_error).toBe(true)
    expect(result.content).toContain('File not found')
  })
})

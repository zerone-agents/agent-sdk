import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  MAX_AGENTS_MD_BYTES,
  readWithLimit,
  findProjectRoot,
  type LoadedFile,
  type Level,
} from './agents-md.js'

describe('agents-md constants and types', () => {
  it('exposes a 32 KiB size limit', () => {
    expect(MAX_AGENTS_MD_BYTES).toBe(32 * 1024)
  })

  it('LoadedFile carries path plus exactly one of content/error', () => {
    const ok: LoadedFile = { path: '/x/AGENTS.md', content: 'body', error: null }
    const bad: LoadedFile = { path: '/y/AGENTS.md', content: null, error: 'too big' }
    expect(ok.content).toBe('body')
    expect(bad.error).toBe('too big')
  })

  it('Level is the literal union "user" | "project"', () => {
    const levels: Level[] = ['user', 'project']
    expect(levels).toEqual(['user', 'project'])
  })
})

describe('readWithLimit', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agents-md-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns content for a normally-sized file', async () => {
    const path = join(dir, 'AGENTS.md')
    await writeFile(path, 'hello world', 'utf-8')
    const result = await readWithLimit(path, MAX_AGENTS_MD_BYTES)
    expect(result).toEqual({ path, content: 'hello world', error: null })
  })

  it('returns null when the file does not exist', async () => {
    const result = await readWithLimit(join(dir, 'missing.md'), MAX_AGENTS_MD_BYTES)
    expect(result).toBeNull()
  })

  it('returns an error marker when file exceeds the limit (boundary: limit+1)', async () => {
    const path = join(dir, 'big.md')
    await writeFile(path, 'a'.repeat(MAX_AGENTS_MD_BYTES + 1))
    const result = await readWithLimit(path, MAX_AGENTS_MD_BYTES)
    expect(result?.content).toBeNull()
    expect(result?.error).toMatch(/exceeds 32.*KiB.*32769 bytes/i)
    expect(result?.error).toContain(String(MAX_AGENTS_MD_BYTES + 1))
    expect(result?.path).toBe(path)
  })

  it('accepts a file exactly at the limit (boundary: limit)', async () => {
    const path = join(dir, 'exact.md')
    await writeFile(path, 'a'.repeat(MAX_AGENTS_MD_BYTES))
    const result = await readWithLimit(path, MAX_AGENTS_MD_BYTES)
    expect(result?.error).toBeNull()
    expect(result?.content).toHaveLength(MAX_AGENTS_MD_BYTES)
  })
})

describe('findProjectRoot', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agents-md-root-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns cwd when .git exists at cwd (as a directory)', async () => {
    await mkdir(join(dir, '.git'))
    expect(await findProjectRoot(dir)).toBe(dir)
  })

  it('returns cwd when .git exists at cwd (as a file, e.g. worktree)', async () => {
    await writeFile(join(dir, '.git'), 'gitdir: /elsewhere\n')
    expect(await findProjectRoot(dir)).toBe(dir)
  })

  it('returns parent when .git is in a parent directory', async () => {
    // /tmp/xxx/.git  +  /tmp/xxx/sub/sub2/cwd
    await mkdir(join(dir, '.git'))
    const deep = join(dir, 'sub', 'sub2')
    await mkdir(deep, { recursive: true })
    expect(await findProjectRoot(deep)).toBe(dir)
  })

  it('returns cwd (fallback) when no .git exists up to filesystem root', async () => {
    // dir is a temp dir; macOS /var/folders has no .git ancestor.
    expect(await findProjectRoot(dir)).toBe(dir)
  })
})

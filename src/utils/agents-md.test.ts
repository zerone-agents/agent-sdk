import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  MAX_AGENTS_MD_BYTES,
  readWithLimit,
  findProjectRoot,
  collectProjectPaths,
  render,
  loadAgentsMd,
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

describe('collectProjectPaths', () => {
  it('returns a single path when root === cwd', () => {
    const root = '/repo'
    expect(collectProjectPaths(root, root)).toEqual(['/repo/AGENTS.md'])
  })

  it('returns two paths when root is the direct parent of cwd', () => {
    expect(collectProjectPaths('/repo', '/repo/src')).toEqual([
      '/repo/AGENTS.md',
      '/repo/src/AGENTS.md',
    ])
  })

  it('returns paths in root-first order across multiple levels', () => {
    expect(collectProjectPaths('/repo', '/repo/src/components')).toEqual([
      '/repo/AGENTS.md',
      '/repo/src/AGENTS.md',
      '/repo/src/components/AGENTS.md',
    ])
  })

  it('preserves order regardless of which intermediate dirs actually contain AGENTS.md', () => {
    // collectProjectPaths does not stat; it just enumerates candidates.
    // The caller filters by readWithLimit returning non-null.
    expect(collectProjectPaths('/a', '/a/b/c/d')).toHaveLength(4)
    expect(collectProjectPaths('/a', '/a/b/c/d')[0]).toBe('/a/AGENTS.md')
    expect(collectProjectPaths('/a', '/a/b/c/d')[3]).toBe('/a/b/c/d/AGENTS.md')
  })
})

describe('render', () => {
  it('renders a successful user file as a <user-level> XML node', () => {
    const file: LoadedFile = { path: '/Users/x/.agents/AGENTS.md', content: 'be nice', error: null }
    expect(render(file, 'user')).toBe(
      '<user-level path="/Users/x/.agents/AGENTS.md">\nbe nice\n</user-level>',
    )
  })

  it('renders a successful project file as a <project-level> XML node', () => {
    const file: LoadedFile = { path: '/repo/AGENTS.md', content: 'do good', error: null }
    expect(render(file, 'project')).toBe(
      '<project-level path="/repo/AGENTS.md">\ndo good\n</project-level>',
    )
  })

  it('renders an error file with [ERROR] body inside the XML node', () => {
    const file: LoadedFile = { path: '/repo/AGENTS.md', content: null, error: 'too big' }
    expect(render(file, 'project')).toBe(
      '<project-level path="/repo/AGENTS.md">\n[ERROR] too big\n</project-level>',
    )
  })
})

describe('loadAgentsMd (integration)', () => {
  let dir: string
  let originalHome: string | undefined

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agents-md-int-'))
    originalHome = process.env.HOME
  })

  afterEach(async () => {
    process.env.HOME = originalHome
    await rm(dir, { recursive: true, force: true })
  })

  it('returns null when settingSources is empty', async () => {
    expect(await loadAgentsMd(dir, [])).toBeNull()
  })

  it('returns null when settingSources is undefined', async () => {
    expect(await loadAgentsMd(dir, undefined)).toBeNull()
  })

  it('reads ~/.agents/AGENTS.md when settingSources includes user', async () => {
    // Set HOME to dir so user-level file is at dir/.agents/AGENTS.md
    process.env.HOME = dir
    await mkdir(join(dir, '.agents'))
    await writeFile(join(dir, '.agents', 'AGENTS.md'), 'user rules', 'utf-8')

    const result = await loadAgentsMd(dir, ['user'])
    expect(result).toBe(
      `<instructions>\n` +
      `<user-level path="${join(dir, '.agents', 'AGENTS.md')}">\nuser rules\n</user-level>\n` +
      `</instructions>`,
    )
  })

  it('reads <cwd>/AGENTS.md when no .git exists (fallback to cwd-only)', async () => {
    await writeFile(join(dir, 'AGENTS.md'), 'cwd rules', 'utf-8')
    const result = await loadAgentsMd(dir, ['project'])
    expect(result).toBe(
      `<instructions>\n` +
      `<project-level path="${join(dir, 'AGENTS.md')}">\ncwd rules\n</project-level>\n` +
      `</instructions>`,
    )
  })

  it('walks from .git root to cwd, concatenating files in root-first order', async () => {
    // Layout: dir/.git, dir/AGENTS.md, dir/sub/AGENTS.md, dir/sub/inner/AGENTS.md
    // cwd = dir/sub/inner
    await mkdir(join(dir, '.git'))
    await writeFile(join(dir, 'AGENTS.md'), 'root rules')
    await mkdir(join(dir, 'sub', 'inner'), { recursive: true })
    await writeFile(join(dir, 'sub', 'AGENTS.md'), 'mid rules')
    await writeFile(join(dir, 'sub', 'inner', 'AGENTS.md'), 'cwd rules')

    const cwd = join(dir, 'sub', 'inner')
    const result = await loadAgentsMd(cwd, ['project'])

    const rootPath = join(dir, 'AGENTS.md')
    const midPath = join(dir, 'sub', 'AGENTS.md')
    const cwdPath = join(dir, 'sub', 'inner', 'AGENTS.md')
    expect(result).toBe(
      `<instructions>\n` +
      `<project-level path="${rootPath}">\nroot rules\n</project-level>\n` +
      `<project-level path="${midPath}">\nmid rules\n</project-level>\n` +
      `<project-level path="${cwdPath}">\ncwd rules\n</project-level>\n` +
      `</instructions>`,
    )
  })

  it('does NOT read <cwd>/.agents/AGENTS.md (removed path, regression)', async () => {
    await mkdir(join(dir, '.agents'))
    await writeFile(join(dir, '.agents', 'AGENTS.md'), 'hidden rules')
    // No git repo here, so fallback to cwd. <cwd>/AGENTS.md should be read,
    // <cwd>/.agents/AGENTS.md should NOT.
    const result = await loadAgentsMd(dir, ['project'])
    expect(result).toBeNull()
  })

  it('replaces an oversize file with an [ERROR] block but still loads siblings', async () => {
    await mkdir(join(dir, '.git'))
    await writeFile(join(dir, 'AGENTS.md'), 'a'.repeat(MAX_AGENTS_MD_BYTES + 1))
    await mkdir(join(dir, 'sub'), { recursive: true })
    await writeFile(join(dir, 'sub', 'AGENTS.md'), 'small sibling')
    const cwd = join(dir, 'sub')

    const result = await loadAgentsMd(cwd, ['project'])
    expect(result).toContain('[ERROR]')
    expect(result).toContain('exceeds 32 KiB')
    expect(result).toContain(join(dir, 'sub', 'AGENTS.md'))
    expect(result).toContain('small sibling')
    // Top-level wrapper is present
    expect(result?.startsWith('<instructions>\n')).toBe(true)
    expect(result?.endsWith('</instructions>')).toBe(true)
  })

  it('loads user and project sections together in order user-then-project', async () => {
    process.env.HOME = dir
    await mkdir(join(dir, '.agents'))
    await writeFile(join(dir, '.agents', 'AGENTS.md'), 'user rules')
    await mkdir(join(dir, '.git'))
    await writeFile(join(dir, 'AGENTS.md'), 'project rules')

    const result = await loadAgentsMd(dir, ['user', 'project'])
    const userNode = `<user-level path="${join(dir, '.agents', 'AGENTS.md')}">`
    const projectNode = `<project-level path="${join(dir, 'AGENTS.md')}">`
    expect(result).toContain(userNode)
    expect(result).toContain(projectNode)
    expect(result!.indexOf(userNode)).toBeLessThan(result!.indexOf(projectNode))
  })

  it('emits no <instructions> block when no instruction files are loaded', async () => {
    // settingSources includes 'project' but no AGENTS.md exists anywhere.
    expect(await loadAgentsMd(dir, ['project'])).toBeNull()
  })
})

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { SnapshotEngine } from './index.js'

describe('SnapshotEngine', () => {
  let worktree: string
  let engine: SnapshotEngine

  beforeEach(async () => {
    worktree = await mkdtemp(join(tmpdir(), 'snap-test-'))
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const exec = promisify(execFile)
    await exec('git', ['init'], { cwd: worktree })

    engine = new SnapshotEngine({ worktree, snapshotDir: worktree + '-snapshot' })
    await engine.init()
  })

  afterEach(async () => {
    await rm(worktree, { recursive: true, force: true })
    await rm(worktree + '-snapshot', { recursive: true, force: true })
  })

  describe('track()', () => {
    it('returns a tree hash for current workspace state', async () => {
      await writeFile(join(worktree, 'hello.txt'), 'hello world')
      const hash = await engine.track()
      expect(hash).toMatch(/^[0-9a-f]{40}$/)
    })

    it('returns different hashes for different content', async () => {
      await writeFile(join(worktree, 'a.txt'), 'version 1')
      const hash1 = await engine.track()

      await writeFile(join(worktree, 'a.txt'), 'version 2')
      const hash2 = await engine.track()

      expect(hash1).not.toBe(hash2)
    })

    it('returns same hash for identical content', async () => {
      await writeFile(join(worktree, 'a.txt'), 'same')
      const hash1 = await engine.track()
      const hash2 = await engine.track()
      expect(hash1).toBe(hash2)
    })
  })

  describe('restore()', () => {
    it('restores workspace to a previous snapshot', async () => {
      await writeFile(join(worktree, 'file.txt'), 'original')
      const hash = await engine.track()

      await writeFile(join(worktree, 'file.txt'), 'modified')
      expect(await readFile(join(worktree, 'file.txt'), 'utf-8')).toBe('modified')

      await engine.restore(hash)
      expect(await readFile(join(worktree, 'file.txt'), 'utf-8')).toBe('original')
    })
  })

  describe('patchList()', () => {
    it('lists files changed since a snapshot', async () => {
      await writeFile(join(worktree, 'a.txt'), 'v1')
      const hash = await engine.track()

      await writeFile(join(worktree, 'a.txt'), 'v2')
      await writeFile(join(worktree, 'b.txt'), 'new')

      const changed = await engine.patchList(hash)
      expect(changed).toContain('a.txt')
      expect(changed).toContain('b.txt')
    })

    it('returns empty when nothing changed', async () => {
      await writeFile(join(worktree, 'stable.txt'), 'same')
      const hash = await engine.track()
      const changed = await engine.patchList(hash)
      expect(changed).toEqual([])
    })
  })

  describe('diff()', () => {
    it('produces a unified diff text', async () => {
      await writeFile(join(worktree, 'src.txt'), 'line1\n')
      const hash = await engine.track()

      await writeFile(join(worktree, 'src.txt'), 'line1\nline2\n')
      const diffText = await engine.diff(hash)

      expect(diffText).toContain('src.txt')
      expect(diffText).toContain('+line2')
    })
  })

  describe('revert()', () => {
    it('reverts specific files to a previous snapshot', async () => {
      await writeFile(join(worktree, 'keep.txt'), 'keep-me')
      await writeFile(join(worktree, 'revert.txt'), 'original')
      const hash = await engine.track()

      await writeFile(join(worktree, 'revert.txt'), 'changed')
      await writeFile(join(worktree, 'keep.txt'), 'also-changed')

      await engine.revert([{ hash, path: 'revert.txt' }])

      expect(await readFile(join(worktree, 'revert.txt'), 'utf-8')).toBe('original')
      expect(await readFile(join(worktree, 'keep.txt'), 'utf-8')).toBe('also-changed')
    })

    it('deletes files that did not exist in the snapshot', async () => {
      await writeFile(join(worktree, 'old.txt'), 'exists')
      const hash = await engine.track()

      await writeFile(join(worktree, 'new-file.txt'), 'created after snapshot')

      await engine.revert([{ hash, path: 'new-file.txt' }])

      await expect(readFile(join(worktree, 'new-file.txt'), 'utf-8')).rejects.toThrow()
    })

    it('handles multiple files in one call', async () => {
      await writeFile(join(worktree, 'a.txt'), 'a1')
      await writeFile(join(worktree, 'b.txt'), 'b1')
      const hash = await engine.track()

      await writeFile(join(worktree, 'a.txt'), 'a2')
      await writeFile(join(worktree, 'b.txt'), 'b2')

      await engine.revert([
        { hash, path: 'a.txt' },
        { hash, path: 'b.txt' },
      ])

      expect(await readFile(join(worktree, 'a.txt'), 'utf-8')).toBe('a1')
      expect(await readFile(join(worktree, 'b.txt'), 'utf-8')).toBe('b1')
    })
  })
})

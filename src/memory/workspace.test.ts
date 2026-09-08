import { mkdtemp, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryValidationError } from './errors.js'
import {
  canonicalizeWorkspacePath,
  defaultMemoryWorkspaceResolver,
  workspaceIdFromCanonicalPath,
} from './workspace.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'mem-ws-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('canonicalizeWorkspacePath', () => {
  it('resolves relative references against cwd to an absolute path', async () => {
    const result = await canonicalizeWorkspacePath('.')
    expect(path.isAbsolute(result)).toBe(true)
  })

  it('resolves symlinks via realpath', async () => {
    const link = path.join(dir, 'link')
    await symlink(dir, link)
    // macOS: tmpdir itself may contain a /var -> /private/var symlink; realpath
    // must collapse BOTH the leaf link and platform prefix aliases.
    expect(await canonicalizeWorkspacePath(link)).toBe(await canonicalizeWorkspacePath(dir))
  })

  it('falls back to the lexical absolute path when realpath fails', async () => {
    const missing = path.join(dir, 'does-not-exist')
    expect(await canonicalizeWorkspacePath(missing)).toBe(path.resolve(missing))
  })

  it('rejects a filesystem root', async () => {
    await expect(canonicalizeWorkspacePath(path.parse(dir).root)).rejects.toThrow(/root/i)
  })

  it('rejects a symlink resolving to the filesystem root', async () => {
    const linkToRoot = path.join(dir, 'link-to-root')
    await symlink(path.parse(dir).root, linkToRoot)
    const rejected = await canonicalizeWorkspacePath(linkToRoot).catch((error: unknown) => error)
    expect(rejected).toBeInstanceOf(MemoryValidationError)
    expect((rejected as MemoryValidationError).findings).toContainEqual(
      expect.objectContaining({ code: 'workspace.root', severity: 'error' }),
    )
  })
})

describe('workspaceIdFromCanonicalPath', () => {
  it('returns a stable 64-char lowercase SHA-256 hex', () => {
    const a = workspaceIdFromCanonicalPath('/repo/a')
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(workspaceIdFromCanonicalPath('/repo/a')).toBe(a)
    expect(workspaceIdFromCanonicalPath('/repo/b')).not.toBe(a)
  })
})

describe('defaultMemoryWorkspaceResolver', () => {
  it('returns { id, canonicalPath } consistent with the helpers', async () => {
    const ws = await defaultMemoryWorkspaceResolver(dir)
    expect(ws.canonicalPath).toBe(await canonicalizeWorkspacePath(dir))
    expect(ws.id).toBe(workspaceIdFromCanonicalPath(ws.canonicalPath))
  })
})
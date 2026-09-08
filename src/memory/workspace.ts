import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import path from 'node:path'

import type { MemoryWorkspace } from './types.js'
import { MemoryValidationError } from './errors.js'

/** Resolves a host workspace reference (normally a cwd) to a stable identity. */
export type MemoryWorkspaceResolver = (reference: string) => Promise<MemoryWorkspace>

/**
 * Canonical workspace path: absolute, symlinks resolved via native realpath
 * when possible (lexical fallback when the path does not exist yet), trailing
 * separators stripped. Rejects the filesystem root.
 */
export async function canonicalizeWorkspacePath(reference: string): Promise<string> {
  const absolute = path.resolve(reference)
  if (absolute === path.parse(absolute).root) {
    throw new MemoryValidationError([
      { code: 'workspace.root', severity: 'error', message: 'A filesystem root cannot be a memory workspace.' },
    ])
  }
  let canonical: string
  try {
    canonical = await realpath(absolute)
  } catch {
    canonical = absolute
  }
  // A reference can indirectly point at the root through a symlink chain
  // (lexically non-root); realpath collapses it, so re-check after resolution.
  if (canonical === path.parse(canonical).root) {
    throw new MemoryValidationError([
      { code: 'workspace.root', severity: 'error', message: 'A filesystem root cannot be a memory workspace.' },
    ])
  }
  // Strip trailing separators (root already rejected above).
  while (canonical.length > 1 && (canonical.endsWith('/') || canonical.endsWith('\\'))) {
    canonical = canonical.slice(0, -1)
  }
  return canonical
}

/** Stable workspace ID: SHA-256 hex of the canonical path. */
export function workspaceIdFromCanonicalPath(canonicalPath: string): string {
  return createHash('sha256').update(canonicalPath, 'utf8').digest('hex')
}

/** Default resolver: canonicalize + SHA-256. Zerone reuses this so existing IDs stay stable. */
export const defaultMemoryWorkspaceResolver: MemoryWorkspaceResolver = async (reference) => {
  const canonicalPath = await canonicalizeWorkspacePath(reference)
  return { id: workspaceIdFromCanonicalPath(canonicalPath), canonicalPath }
}
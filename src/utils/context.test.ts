import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { getSystemContext } from './context.js'

const execFileAsync = promisify(execFile)

describe('getSystemContext', () => {
  let gitDir: string
  let nonGitDir: string

  beforeEach(async () => {
    gitDir = await mkdtemp(join(tmpdir(), 'ctx-git-'))
    nonGitDir = await mkdtemp(join(tmpdir(), 'ctx-nogit-'))
    await execFileAsync('git', ['init'], { cwd: gitDir })
  })

  afterEach(async () => {
    await Promise.all([
      rm(gitDir, { recursive: true, force: true }),
      rm(nonGitDir, { recursive: true, force: true }),
    ])
  })

  it('reports "yes" inside a git repo', async () => {
    const out = await getSystemContext(gitDir, 'test-model')
    expect(out).toContain('Is directory a git repo: yes')
  })

  it('reports "no" outside a git repo', async () => {
    const out = await getSystemContext(nonGitDir)
    expect(out).toContain('Is directory a git repo: no')
  })

  it('does not block the event loop while running git check', async () => {
    // While getSystemContext is in-flight, a setTimeout(0) should still fire
    // approximately on time. execSync would block it.
    let tickFired = false
    const tick = new Promise<void>((resolve) => {
      const start = Date.now()
      setTimeout(() => {
        tickFired = true
        // Should fire within a few ms; execSync would delay by git startup time
        expect(Date.now() - start).toBeLessThan(500)
        resolve()
      }, 1)
    })

    await Promise.all([
      getSystemContext(gitDir),
      tick,
    ])
    expect(tickFired).toBe(true)
  })
})

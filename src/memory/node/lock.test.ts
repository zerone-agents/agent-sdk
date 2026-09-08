// src/memory/node/lock.test.ts
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { acquireMemoryLock } from './lock.js'
import { MemoryStorageLockError } from '../errors.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'mem-lock-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const lockPath = () => path.join(dir, 'runtime.lock')

describe('acquireMemoryLock (fail-closed by design, review P1-1)', () => {
  it('acquires, records the owner pid, and releases idempotently', async () => {
    const lock = await acquireMemoryLock(dir)
    expect(JSON.parse(await readFile(lockPath(), 'utf8')).pid).toBe(process.pid)
    await lock.release()
    await lock.release() // idempotent
    await expect(readFile(lockPath(), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('a live second owner gets MemoryStorageLockError naming the path', async () => {
    await acquireMemoryLock(dir)
    await expect(acquireMemoryLock(dir)).rejects.toSatisfy(
      (e) => e instanceof MemoryStorageLockError && e.lockPath === lockPath(),
    )
  })

  it('an existing stale-looking lock file also fails closed — NO automatic reclamation', async () => {
    // A lock whose recorded owner would be provably dead (spawn + reap a child,
    // then write its pid into the lock) must STILL reject: reclamation is a
    // check-then-act race that breaks the single-writer guarantee (P1-1).
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'])
    const deadPid = child.pid!
    child.kill()
    await once(child, 'exit')
    await writeFile(lockPath(), JSON.stringify({ pid: deadPid, acquiredAt: new Date().toISOString() }))
    await expect(acquireMemoryLock(dir)).rejects.toSatisfy((e) =>
      e instanceof MemoryStorageLockError && /manual/i.test(e.message))
    expect(JSON.parse(await readFile(lockPath(), 'utf8')).pid).toBe(deadPid) // untouched
  })

  it('fails closed on an unparseable lock file', async () => {
    await writeFile(lockPath(), 'not json')
    await expect(acquireMemoryLock(dir)).rejects.toThrow(MemoryStorageLockError)
  })
})
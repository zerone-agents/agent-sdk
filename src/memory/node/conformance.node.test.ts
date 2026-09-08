import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll } from 'vitest'
import { runMemoryStorageConformance } from '../conformance.js'
import { NodeFileMemoryStorage } from './file-storage.js'

// The suite's durability test calls factory() then reopen() over the SAME
// root: keep the most recent dir so reopen() targets what factory) created —
// but track every dir created and clean them all up after the run.
const createdDirs: string[] = []
let currentDir = ''
await runMemoryStorageConformance(
  'NodeFileMemoryStorage',
  async () => {
    currentDir = await mkdtemp(path.join(tmpdir(), 'mem-node-conf-'))
    createdDirs.push(currentDir)
    return new NodeFileMemoryStorage(currentDir)
  },
  { reopen: async () => new NodeFileMemoryStorage(currentDir) },
)
afterAll(async () => {
  await Promise.all(createdDirs.map((d) => rm(d, { recursive: true, force: true })))
})

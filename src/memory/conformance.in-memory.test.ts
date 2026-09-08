// src/memory/conformance.in-memory.test.ts
import { runMemoryStorageConformance } from './conformance.js'
import { InMemoryMemoryStorage } from './in-memory-storage.js'
import type { MemoryStorage } from './storage.js'

let current: InMemoryMemoryStorage | null = null
runMemoryStorageConformance(
  'InMemoryMemoryStorage',
  () => {
    current = new InMemoryMemoryStorage()
    return current
  },
  {
    failNextCommit: (_storage: MemoryStorage, error: Error) => current!.failNextCommit(error),
  },
)
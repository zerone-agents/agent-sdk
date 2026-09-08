import { homedir } from 'node:os'
import path from 'node:path'
import { createMemoryService } from '../service.js'
import type { MemoryService, MemoryBudgets } from '../types.js'
import type { MemoryContentPolicy } from '../policy.js'
import type { MemoryEventSink } from '../events.js'
import type { DiagnosticsSink } from '../../utils/diagnostics.js'
import { NodeFileMemoryStorage } from './file-storage.js'

export function defaultMemoryDataDir(): string {
  return path.join(homedir(), '.agents')
}

export interface CreateDefaultMemoryServiceOptions {
  /** Root data directory; memory state lives under `<dataDir>/memory` (default `~/.agents`). */
  dataDir?: string
  budgets?: Partial<MemoryBudgets>
  policy?: MemoryContentPolicy
  events?: MemoryEventSink
  diagnostics?: DiagnosticsSink
  now?: () => Date
  newId?: () => string
}

/**
 * Default Node memory service: NodeFileMemoryStorage under
 * `<dataDir>/memory` (default `~/.agents/memory`) + in-process MemoryService.
 * `start()` acquires the single-writer lock and creates the directory;
 * nothing is created by this factory call (spec: no implicit data dirs).
 */
export function createDefaultMemoryService(options: CreateDefaultMemoryServiceOptions = {}): MemoryService {
  const memoryDir = path.join(options.dataDir ?? defaultMemoryDataDir(), 'memory')
  const storage = new NodeFileMemoryStorage(memoryDir, { diagnostics: options.diagnostics })
  return createMemoryService({
    storage,
    budgets: options.budgets,
    policy: options.policy,
    events: options.events,
    diagnostics: options.diagnostics,
    now: options.now,
    newId: options.newId,
  })
}
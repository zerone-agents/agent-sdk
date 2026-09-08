// Memory: host-independent long-term memory (issue #61)

// Domain types
export type {
  MemoryAdministration,
  MemoryAuditEvent,
  MemoryAuditQuery,
  MemoryBudgets,
  MemoryImportance,
  MemoryInvocationContext,
  MemoryMutationCommand,
  MemoryMutationResult,
  MemoryOperation,
  MemoryRecord,
  MemoryRecordQuery,
  MemoryReplaceChanges,
  MemoryScope,
  MemorySearchQuery,
  MemorySession,
  MemorySessionCreateInput,
  MemoryStatus,
  MemoryWorkspace,
} from './types.js'
export { DEFAULT_MEMORY_BUDGETS } from './types.js'

// Errors
export type { MemoryServicePhase } from './errors.js'
export {
  MemoryAccessError,
  MemoryConflictError,
  MemoryNotFoundError,
  MemoryServiceUnavailableError,
  MemoryStorageCorruptionError,
  MemoryStorageLockError,
  MemoryValidationError,
} from './errors.js'
export type { MemoryPolicyFinding } from './errors.js'

// Workspace helpers
export type { MemoryWorkspaceResolver } from './workspace.js'
export {
  canonicalizeWorkspacePath,
  defaultMemoryWorkspaceResolver,
  workspaceIdFromCanonicalPath,
} from './workspace.js'

// Length / search / render constants + pure functions
export { countMemoryChars } from './length.js'
export {
  compareMemorySearchResults,
  matchMemoryRecord,
  MEMORY_SEARCH_DEFAULT_LIMIT,
  MEMORY_SEARCH_MAX_LIMIT,
  normalizeMemoryText,
  resolveMemorySearchLimit,
} from './search.js'
export type { MemoryMatchKind, MemorySearchMatch } from './search.js'
export {
  escapeMemoryXml,
  MEMORY_CONTEXT_PREAMBLE,
  MEMORY_IMPORTANCE_LABELS,
  renderMemoryContext,
} from './render.js'
export type { RenderMemoryContextInput } from './render.js'

// Content policy
export type { MemoryContentPolicy, MemoryContentPolicyInput } from './policy.js'
export { createDefaultMemoryContentPolicy, maskSecret } from './policy.js'

// Events
export type { MemoryEvent, MemoryEventSink } from './events.js'

// Storage seam
export type {
  MemoryStorage,
  MemoryStorageAuditQuery,
  MemoryStorageCommit,
  MemoryStorageRecordQuery,
} from './storage.js'

// In-memory adapter
export { InMemoryMemoryStorage } from './in-memory-storage.js'
export type { InMemoryMemoryStorageOptions } from './in-memory-storage.js'

// Conformance suite — TEST infrastructure: vitest is imported lazily at call
// time, so merely importing the package root never requires vitest (the SDK
// ships no vitest dependency). Consumers running the suite need vitest.
export { runMemoryStorageConformance } from './conformance.js'
export type { MemoryStorageConformanceHooks } from './conformance.js'

// Service (single entry point)
export { createMemoryService } from './service.js'
export type { MemoryServiceOptions } from './service.js'

import type { MemoryInvocationContext, MemoryMutationResult } from './types.js'

/** Emitted AFTER a successful commit; sinks are observational (failures → diagnostics). */
export interface MemoryEvent {
  result: MemoryMutationResult
  context: MemoryInvocationContext
}

export type MemoryEventSink = (event: MemoryEvent) => void
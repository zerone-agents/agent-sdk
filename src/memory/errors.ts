import type { MemoryRecord } from './types.js'

export type MemoryServicePhase = 'stopped' | 'starting' | 'running' | 'stopping'

export interface MemoryPolicyFinding {
  /** Stable machine code, e.g. 'content.empty', 'secret.detected'. */
  code: string
  severity: 'warning' | 'error'
  /** Must not contain a complete suspected secret. */
  message: string
}

export class MemoryServiceUnavailableError extends Error {
  readonly method: string
  readonly phase: MemoryServicePhase
  constructor(method: string, phase: MemoryServicePhase) {
    super(
      `Memory service cannot ${method}: lifecycle phase is "${phase}".` +
        (phase === 'stopping' ? ' The service is shutting down.' : ''),
    )
    this.name = 'MemoryServiceUnavailableError'
    this.method = method
    this.phase = phase
  }
}

export class MemoryConflictError extends Error {
  /** The current stored record (with its actual revision). */
  readonly record: MemoryRecord
  constructor(record: MemoryRecord) {
    super(`Memory record ${record.id} was modified concurrently (current revision: ${record.revision}). Re-read and retry.`)
    this.name = 'MemoryConflictError'
    this.record = record
  }
}

export class MemoryAccessError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MemoryAccessError'
  }
}

export class MemoryValidationError extends Error {
  readonly findings: MemoryPolicyFinding[]
  constructor(findings: MemoryPolicyFinding[]) {
    super(`Memory validation failed: ${findings.map((f) => `[${f.code}] ${f.message}`).join('; ')}`)
    this.name = 'MemoryValidationError'
    this.findings = findings
  }
}

export class MemoryNotFoundError extends Error {
  readonly recordId: string
  constructor(recordId: string) {
    super(`Memory record not found: ${recordId}`)
    this.name = 'MemoryNotFoundError'
    this.recordId = recordId
  }
}

export class MemoryStorageCorruptionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'MemoryStorageCorruptionError'
  }
}

export class MemoryStorageLockError extends Error {
  readonly lockPath: string
  constructor(lockPath: string, detail?: string) {
    super(`Memory storage is locked: ${lockPath}${detail ? ` — ${detail}` : ''}`)
    this.name = 'MemoryStorageLockError'
    this.lockPath = lockPath
  }
}
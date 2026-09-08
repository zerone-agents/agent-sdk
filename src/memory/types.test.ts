import { describe, expect, it } from 'vitest'
import {
  MemoryAccessError,
  MemoryConflictError,
  MemoryNotFoundError,
  MemoryServiceUnavailableError,
  MemoryStorageCorruptionError,
  MemoryStorageLockError,
  MemoryValidationError,
} from './errors.js'
import { DEFAULT_MEMORY_BUDGETS } from './types.js'
import type { MemoryRecord } from './types.js'

describe('memory errors', () => {
  it('MemoryServiceUnavailableError carries method and phase', () => {
    const err = new MemoryServiceUnavailableError('bind', 'stopped')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('MemoryServiceUnavailableError')
    expect(err.method).toBe('bind')
    expect(err.phase).toBe('stopped')
    expect(err.message).toContain('bind')
    expect(err.message).toContain('stopped')
  })

  it('MemoryConflictError carries the current record', () => {
    const record = { id: 'r1', revision: 3 } as MemoryRecord
    const err = new MemoryConflictError(record)
    expect(err.name).toBe('MemoryConflictError')
    expect(err.record).toBe(record)
  })

  it('MemoryValidationError carries stable finding codes', () => {
    const err = new MemoryValidationError([{ code: 'content.empty', severity: 'error', message: 'empty' }])
    expect(err.name).toBe('MemoryValidationError')
    expect(err.findings.map((f) => f.code)).toEqual(['content.empty'])
  })

  it('remaining error classes are distinguishable by name', () => {
    expect(new MemoryAccessError('nope').name).toBe('MemoryAccessError')
    expect(new MemoryNotFoundError('r1').name).toBe('MemoryNotFoundError')
    expect(new MemoryNotFoundError('r1').recordId).toBe('r1')
    expect(new MemoryStorageCorruptionError('bad').name).toBe('MemoryStorageCorruptionError')
    expect(new MemoryStorageLockError('/x/runtime.lock').name).toBe('MemoryStorageLockError')
    expect(new MemoryStorageLockError('/x/runtime.lock').lockPath).toBe('/x/runtime.lock')
  })
})

describe('DEFAULT_MEMORY_BUDGETS', () => {
  it('matches the spec defaults', () => {
    expect(DEFAULT_MEMORY_BUDGETS).toEqual({
      globalChars: 22_000,
      userChars: 1_375,
      workspaceChars: 10_000,
      auditRetention: 200,
    })
  })
})
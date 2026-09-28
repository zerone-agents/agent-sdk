import { describe, expect, it } from 'vitest'
import { assertIntentShape, type OperationIntent, type ChangeSet } from './types.js'
import {
  OperationConflictError,
  OwnershipMismatchError,
  RollbackTargetInvalidError,
  WriteNotAuthorizedError,
} from './errors.js'

const rec = (recordId: string, messageId: string): never => ({ recordId, message: { id: messageId, role: 'user', content: 'x' }, actor: { kind: 'main' } }) as never
const cs = (kind: ChangeSet['kind']): ChangeSet =>
  ({ kind, branchId: 'b1', newRecords: [rec('r1', 'm1')] }) as ChangeSet

describe('assertIntentShape (issue #131)', () => {
  it('accepts a checkpoint intent with explicit revision premise', () => {
    const intent: OperationIntent = { kind: 'checkpoint', changeSet: cs('checkpoint'), expectedRevision: 3 }
    expect(() => assertIntentShape('s1', intent)).not.toThrow()
  })

  it('rejects missing expectedRevision on transcript ops (no guard-free channel)', () => {
    const intent = { kind: 'checkpoint', changeSet: cs('checkpoint') } as unknown as OperationIntent
    expect(() => assertIntentShape('s1', intent)).toThrow(/expectedRevision/)
  })

  it('rejects non-null premise on fork/import (create-only literal)', () => {
    const intent = { kind: 'fork', changeSet: cs('fork'), expectedRevision: 5 } as unknown as OperationIntent
    expect(() => assertIntentShape('s1', intent)).toThrow(/create-only/)
    const intent2 = { kind: 'import', changeSet: cs('import'), expectedRevision: 0 } as unknown as OperationIntent
    expect(() => assertIntentShape('s1', intent2)).toThrow(/create-only/)
  })

  it('rejects outer kind / payload kind mismatch (App freeze review #3)', () => {
    const intent = { kind: 'append', changeSet: cs('revise'), expectedRevision: null } as unknown as OperationIntent
    expect(() => assertIntentShape('s1', intent)).toThrow(/kind/)
  })

  it('rejects register/save-todos/delete carrying a revision premise', () => {
    const intent = { kind: 'delete', cascadeOwned: true, expectedRevision: 2 } as unknown as OperationIntent
    expect(() => assertIntentShape('s1', intent)).toThrow(/revision/)
    const intent2 = { kind: 'save-todos', todos: [], expectedRevision: 1 } as unknown as OperationIntent
    expect(() => assertIntentShape('s1', intent2)).toThrow(/revision/)
    const intent3 = { kind: 'register', ownership: { rootSessionId: 's1' }, expectedRevision: 1 } as unknown as OperationIntent
    expect(() => assertIntentShape('s1', intent3)).toThrow(/revision/)
  })

  it('save-todos carries todos; register carries ownership (shape present)', () => {
    expect(() => assertIntentShape('s1', { kind: 'save-todos', todos: [] })).not.toThrow()
    expect(() => assertIntentShape('s1', { kind: 'register', ownership: { rootSessionId: 's1' } })).not.toThrow()
    expect(() => assertIntentShape('s1', { kind: 'delete' })).not.toThrow()
  })
})

describe('v4 error classes', () => {
  it('exports the four new error classes', () => {
    for (const E of [WriteNotAuthorizedError, OperationConflictError, RollbackTargetInvalidError, OwnershipMismatchError]) {
      expect(new E('x')).toBeInstanceOf(Error)
    }
  })
})
import { describe, expect, it } from 'vitest'
import { foldEffective } from './algorithm.js'
import { SessionDataInvalidError } from './errors.js'

const mk = (id: string, mid: string, kind: 'message' | 'summary' = 'message') =>
  [id, { messageId: mid, kind }] as const

describe('foldEffective (issue #131, spec §2.2)', () => {
  it('folds to latest version per messageId, first-appearance order', () => {
    const m = new Map([mk('A1', 'A'), mk('B1', 'B'), mk('A2', 'A')])
    expect(foldEffective(['A1', 'B1', 'A2'], (id) => m.get(id))).toEqual(['A2', 'B1'])
  })

  it('excludes summary records from effective (spec §2.2-#5)', () => {
    const m = new Map([mk('A1', 'A'), mk('S1', 'summary-1', 'summary'), mk('B1', 'B')])
    expect(foldEffective(['A1', 'S1', 'B1'], (id) => m.get(id))).toEqual(['A1', 'B1'])
  })

  it('multi-round compact stays single-layer (revise after compact keeps positions)', () => {
    const m = new Map([mk('A1', 'A'), mk('B1', 'B'), mk('A2', 'A')])
    expect(foldEffective(['A1', 'B1', 'A2'], (id) => m.get(id))).toEqual(['A2', 'B1'])
  })

  it('unknown record ids throw SessionDataInvalidError', () => {
    expect(() => foldEffective(['ghost'], () => undefined)).toThrow(SessionDataInvalidError)
  })

  it('empty logs fold to empty effective', () => {
    expect(foldEffective([], () => undefined)).toEqual([])
  })
})
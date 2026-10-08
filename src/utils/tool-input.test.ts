import { describe, it, expect } from 'vitest'
import { normalizeToolInput } from './tool-input.js'

/**
 * issue #144: bounded recovery + classification of tool-call argument strings.
 *
 * The accumulator/providers deliver tool input as a raw string when JSON.parse
 * fails (or when parse succeeds but yields a string — double-encoded JSON).
 * Normalization must: recover a VALID double-encoded object with ONE extra
 * bounded parse; classify failures (invalid-json / malformed-inner /
 * not-an-object) so the LLM gets a format error instead of a misleading
 * missing-required-fields error; never recursively decode beyond the bound.
 */
describe('normalizeToolInput (issue #144)', () => {
  it('parses a plain JSON object string', () => {
    const r = normalizeToolInput('{"tasks":[{"description":"a"}]}')
    expect(r).toEqual({ ok: true, value: { tasks: [{ description: 'a' }] } })
  })

  it('recovers a valid double-encoded object with one extra bounded parse', () => {
    const inner = JSON.stringify({ tasks: [{ description: 'Review', prompt: 'Read the code' }] })
    const r = normalizeToolInput(JSON.stringify(inner))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual({ tasks: [{ description: 'Review', prompt: 'Read the code' }] })
  })

  it('does NOT recursively decode beyond the bound (triple-encoded stays rejected)', () => {
    const triple = JSON.stringify(JSON.stringify(JSON.stringify({ tasks: [] })))
    const r = normalizeToolInput(triple)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.kind).toBe('not-an-object')
  })

  it('classifies malformed JSON as invalid-json, with a parse offset when available', () => {
    const r = normalizeToolInput('{"tasks":[{"prompt":"Check "data flow" claims"}]}')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.kind).toBe('invalid-json')
      expect(typeof r.offset === 'number' || r.offset === undefined).toBe(true)
    }
  })

  it('classifies a JSON-encoded string containing malformed JSON as malformed-inner', () => {
    const r = normalizeToolInput(JSON.stringify('{"tasks":[{"prompt":"Check "data flow""}]}'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.kind).toBe('malformed-inner')
  })

  it('classifies arrays, null, and scalars as not-an-object', () => {
    for (const raw of ['[1,2]', 'null', '42', 'true']) {
      const r = normalizeToolInput(raw)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.kind).toBe('not-an-object')
    }
  })

  it('classifies a plain JSON string scalar as malformed-inner (decodes to non-JSON text)', () => {
    // JSON.parse('"hello"') → 'hello'; the bounded second parse fails → malformed-inner
    const r = normalizeToolInput('"hello"')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.kind).toBe('malformed-inner')
  })
})

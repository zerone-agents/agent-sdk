import { describe, it, expect } from 'vitest'
import { MAX_AGENTS_MD_BYTES, type LoadedFile, type Level } from './agents-md.js'

describe('agents-md constants and types', () => {
  it('exposes a 32 KiB size limit', () => {
    expect(MAX_AGENTS_MD_BYTES).toBe(32 * 1024)
  })

  it('LoadedFile carries path plus exactly one of content/error', () => {
    const ok: LoadedFile = { path: '/x/AGENTS.md', content: 'body', error: null }
    const bad: LoadedFile = { path: '/y/AGENTS.md', content: null, error: 'too big' }
    expect(ok.content).toBe('body')
    expect(bad.error).toBe('too big')
  })

  it('Level is the literal union "user" | "project"', () => {
    const levels: Level[] = ['user', 'project']
    expect(levels).toEqual(['user', 'project'])
  })
})

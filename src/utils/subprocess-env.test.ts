import { describe, it, expect, afterEach } from 'vitest'
import { resolveSubprocessEnv } from './subprocess-env.js'

describe('resolveSubprocessEnv', () => {
  // Track keys we set on process.env so afterEach can clean them up.
  // (Vitest doesn't isolate process.env between tests by default.)
  const trackedKeys: string[] = []
  const setTrackedHost = (key: string, value: string) => {
    process.env[key] = value
    trackedKeys.push(key)
  }
  afterEach(() => {
    while (trackedKeys.length) {
      delete process.env[trackedKeys.pop()!]
    }
  })

  it('returns a copy of process.env when no options are given', () => {
    setTrackedHost('SUBPROC_TEST_DEFAULT', 'host')
    const env = resolveSubprocessEnv({})

    expect(env.SUBPROC_TEST_DEFAULT).toBe('host')
    expect(env).not.toBe(process.env) // different reference
    // Mutating the returned object must not leak back into process.env.
    env.SUBPROC_TEST_DEFAULT = 'mutated'
    expect(process.env.SUBPROC_TEST_DEFAULT).toBe('host')
  })

  it('merges toolEnv over process.env when toolEnvInherit is undefined or true', () => {
    setTrackedHost('SUBPROC_TEST_HOST', 'host')
    setTrackedHost('SUBPROC_TEST_CONFLICT', 'host')

    const env = resolveSubprocessEnv({
      toolEnv: {
        SUBPROC_TEST_TOOL: 'tool',
        SUBPROC_TEST_CONFLICT: 'tool-override',
      },
      // toolEnvInherit omitted — defaults to true
    })

    expect(env.SUBPROC_TEST_HOST).toBe('host')               // inherited from process.env
    expect(env.SUBPROC_TEST_TOOL).toBe('tool')               // added from toolEnv
    expect(env.SUBPROC_TEST_CONFLICT).toBe('tool-override')  // toolEnv wins
  })

  it('uses only toolEnv when toolEnvInherit is false (process.env fully excluded)', () => {
    setTrackedHost('SUBPROC_TEST_HOST', 'host')
    setTrackedHost('SUBPROC_TEST_SECRET', 'leaked')

    const env = resolveSubprocessEnv({
      toolEnv: { SUBPROC_TEST_TOOL: 'tool' },
      toolEnvInherit: false,
    })

    expect(env.SUBPROC_TEST_TOOL).toBe('tool')
    expect(env.SUBPROC_TEST_HOST).toBeUndefined()
    expect(env.SUBPROC_TEST_SECRET).toBeUndefined()
    expect(Object.keys(env)).not.toContain('SUBPROC_TEST_HOST')
  })

  it('returns empty object when toolEnvInherit is false and toolEnv is missing', () => {
    // Edge case: host opts into full isolation but provides no env at all.
    // Legal (host's responsibility); subprocess will see an empty env.
    const env = resolveSubprocessEnv({ toolEnvInherit: false })
    expect(Object.keys(env)).toHaveLength(0)
  })

  it('returns an independent copy (mutations do not leak to process.env)', () => {
    setTrackedHost('SUBPROC_TEST_IMMUTABLE', 'host')
    const env = resolveSubprocessEnv({})
    delete env.SUBPROC_TEST_IMMUTABLE
    expect(process.env.SUBPROC_TEST_IMMUTABLE).toBe('host')
  })
})

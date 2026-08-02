import { describe, it, expect } from 'vitest'
import { isGitAvailable } from './git-detector.js'

describe('isGitAvailable', () => {
  it('returns true when git is installed', async () => {
    const result = await isGitAvailable()
    expect(result).toBe(true)
  })

  it('caches the result', async () => {
    await isGitAvailable()
    const result = await isGitAvailable()
    expect(typeof result).toBe('boolean')
  })
})

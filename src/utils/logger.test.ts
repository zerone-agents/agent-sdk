import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createLogger, type Logger } from './logger.js'

describe('createLogger', () => {
  let debugSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    debugSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it('prints debug messages by default (backwards compatible)', () => {
    const log = createLogger('engine')
    log.debug('hello')
    expect(debugSpy).toHaveBeenCalledWith('[engine] hello')
  })

  it('does not print trace messages by default', () => {
    const log = createLogger('engine')
    log.trace('verbose detail')
    expect(debugSpy).not.toHaveBeenCalled()
  })

  it('prints trace messages when level is trace', () => {
    const log = createLogger('engine', { level: 'trace' })
    log.trace('verbose detail')
    expect(debugSpy).toHaveBeenCalledWith('[engine] verbose detail')
  })

  it('suppresses debug and trace when level is error', () => {
    const log = createLogger('engine', { level: 'error' })
    log.debug('hidden')
    log.trace('also hidden')
    expect(debugSpy).not.toHaveBeenCalled()
  })

  it('always prints error messages regardless of level', () => {
    for (const level of ['error', 'debug', 'trace'] as const) {
      const log = createLogger('engine', { level })
      log.error('boom')
    }
    expect(errorSpy).toHaveBeenCalledTimes(3)
  })

  it('child logger inherits the level', () => {
    const log = createLogger('engine', { level: 'error' })
    const child = log.child({ component: 'tool-executor' })
    child.debug('hidden')
    expect(debugSpy).not.toHaveBeenCalled()

    const traceLog = createLogger('engine', { level: 'trace' })
    const traceChild = traceLog.child({ component: 'tool-executor' })
    traceChild.trace('shown')
    expect(debugSpy).toHaveBeenCalledWith(
      '[engine] component=tool-executor shown',
    )
  })

  it('satisfies the Logger interface shape', () => {
    const log: Logger = createLogger('engine')
    expect(typeof log.debug).toBe('function')
    expect(typeof log.trace).toBe('function')
    expect(typeof log.error).toBe('function')
    expect(typeof log.child).toBe('function')
  })
})

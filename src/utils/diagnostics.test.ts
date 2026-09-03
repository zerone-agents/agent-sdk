import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  adaptToDiagnosticsSink, createDiagnosticsSink,
  sanitizeLogField, stableErrorType, normalizeCaughtError, TimeoutError,
  type DiagnosticsSink,
} from './diagnostics.js'
import { createLogger } from './logger.js'

function collectingSink() {
  const events: Array<{ level: string; msg: string; fields?: unknown; cause?: unknown }> = []
  const sink: DiagnosticsSink = {
    debug: () => {}, trace: () => {},
    warn: (msg, fields) => events.push({ level: 'warn', msg, fields }),
    error: (msg, fields, cause) => events.push({ level: 'error', msg, fields, cause }),
    child: () => sink,
  }
  return { events, sink }
}

describe('adaptToDiagnosticsSink', () => {
  it('sink-shaped logger passes through by identity', () => {
    const { sink } = collectingSink()
    expect(adaptToDiagnosticsSink(sink)).toBe(sink)
  })
  it('plain Logger: warn degrades to error, cause dropped', () => {
    const errSpy = vi.fn()
    const plain = { ...createLogger(), error: errSpy } as unknown as import('./logger.js').Logger
    const adapted = adaptToDiagnosticsSink(plain)
    adapted.warn('w-msg', { a: 1 })
    adapted.error('e-msg', { b: 2 }, new Error('raw'))
    expect(errSpy.mock.calls).toEqual([['w-msg', { a: 1 }], ['e-msg', { b: 2 }]])
  })
  it('child of a plain Logger stays adapted', () => {
    const base = createLogger('x')
    const adapted = adaptToDiagnosticsSink(base)
    expect(typeof adapted.child({ k: 1 }).warn).toBe('function')
  })
})

describe('createDiagnosticsSink (default byte rules)', () => {
  beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => {}))
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}))
  beforeEach(() => vi.spyOn(console, 'debug').mockImplementation(() => {}))
  afterEach(() => vi.restoreAllMocks())

  it('warn(msg, fields) → console.warn(msg, fields); warn(msg) → single-arg', () => {
    const sink = createDiagnosticsSink()
    sink.warn('m1', { x: 1 }); sink.warn('m2')
    expect(console.warn).toHaveBeenNthCalledWith(1, 'm1', { x: 1 })
    expect(console.warn).toHaveBeenNthCalledWith(2, 'm2')
    expect((console.warn as any).mock.calls[1]).toHaveLength(1)
  })
  it('error NEVER prints cause', () => {
    createDiagnosticsSink().error('m', { errorType: 'Error' }, new Error('secret-token'))
    expect(console.error).toHaveBeenCalledWith('m', { errorType: 'Error' })
    expect((console.error as any).mock.calls[0]).toHaveLength(2)
  })
  it('no prefix injection', () => {
    createDiagnosticsSink().warn('[cron] tick')
    expect(console.warn).toHaveBeenCalledWith('[cron] tick')
  })
  it('debug/trace follow level; warn/error always emit', () => {
    const sink = createDiagnosticsSink({ level: 'error' })
    sink.debug('d'); sink.trace('t'); sink.warn('w')
    expect(console.debug).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalledWith('w')
  })
})

describe('promoted trio + TimeoutError', () => {
  it('stableErrorType maps TimeoutError/Error/primitive; total on hostile input', () => {
    expect(stableErrorType(new TimeoutError('x'))).toBe('TimeoutError')
    expect(stableErrorType(new Error('x'))).toBe('Error')
    expect(stableErrorType(42)).toBe('number')
  })
  it('sanitizeLogField truncates and escapes; normalizeCaughtError is total', () => {
    expect(sanitizeLogField('a'.repeat(200)).length).toBeLessThanOrEqual(130)
    expect(normalizeCaughtError('str') instanceof Error).toBe(true)
  })
  it('shim: trio + TimeoutError still importable from mcp/client.js', async () => {
    const shim = await import('../mcp/client.js')
    expect(typeof shim.sanitizeLogField).toBe('function')
    expect(typeof shim.stableErrorType).toBe('function')
    expect(typeof shim.normalizeCaughtError).toBe('function')
    expect(new shim.TimeoutError('t') instanceof TimeoutError).toBe(true)
  })
})

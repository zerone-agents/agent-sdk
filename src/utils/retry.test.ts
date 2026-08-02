import { describe, expect, it } from 'vitest'
import { classifyError, DEFAULT_MAX_STREAM_RETRIES, getStreamRetryDelay, isRetryableError, parseRetryAfter, withStreamRetry, type RetryEvent } from './retry.js'
import type { StreamChunk } from '../providers/types.js'

// Shape thrown by @anthropic-ai/sdk when the network is down (verified against
// the real client): an APIConnectionError instance whose `name` stays 'Error',
// message 'Connection error.', cause = TypeError('fetch failed'),
// cause.cause = socket error carrying the real code.
class FakeAPIConnectionError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message)
    this.cause = cause
  }
}

function makeAnthropicConnectionError() {
  const socketErr: any = new Error('getaddrinfo ENOTFOUND api.anthropic.com')
  socketErr.code = 'ENOTFOUND'
  const fetchErr: any = new TypeError('fetch failed')
  fetchErr.cause = socketErr
  return new FakeAPIConnectionError('Connection error.', fetchErr)
}

// Shape thrown by raw fetch (undici) when the network is down (OpenAI provider path).
function makeFetchFailedError() {
  const socketErr: any = new Error('getaddrinfo ENOTFOUND api.openai.com')
  socketErr.code = 'ENOTFOUND'
  const err: any = new TypeError('fetch failed')
  err.cause = socketErr
  return err
}

describe('classifyError', () => {
  it('classifies ECONNRESET as connection error (retryable)', () => {
    const err = { code: 'ECONNRESET', message: 'read ECONNRESET' }
    const result = classifyError(err)
    expect(result.type).toBe('connection')
    expect(result.isRetryable).toBe(true)
  })

  it('classifies ETIMEDOUT as connection error (retryable)', () => {
    const err = { code: 'ETIMEDOUT', message: 'connect ETIMEDOUT' }
    const result = classifyError(err)
    expect(result.type).toBe('connection')
    expect(result.isRetryable).toBe(true)
  })

  it('classifies Anthropic SDK APIConnectionError as connection (retryable)', () => {
    const result = classifyError(makeAnthropicConnectionError())
    expect(result.type).toBe('connection')
    expect(result.isRetryable).toBe(true)
  })

  it('classifies undici "fetch failed" (OpenAI provider) as connection (retryable)', () => {
    const result = classifyError(makeFetchFailedError())
    expect(result.type).toBe('connection')
    expect(result.isRetryable).toBe(true)
  })

  it('classifies "fetch failed" without cause code as connection (retryable)', () => {
    const result = classifyError(new TypeError('fetch failed'))
    expect(result.type).toBe('connection')
    expect(result.isRetryable).toBe(true)
  })

  it('classifies APIConnectionTimeoutError as connection (retryable)', () => {
    const err = new FakeAPIConnectionError('Request timed out.')
    const result = classifyError(err)
    expect(result.type).toBe('connection')
    expect(result.isRetryable).toBe(true)
  })

  it('classifies HTTP 429 as rate_limit (retryable)', () => {
    const err = { status: 429, message: 'Too Many Requests' }
    const result = classifyError(err)
    expect(result.type).toBe('rate_limit')
    expect(result.isRetryable).toBe(true)
  })

  it('classifies HTTP 529 as overloaded (retryable)', () => {
    const err = { status: 529, message: 'Overloaded' }
    const result = classifyError(err)
    expect(result.type).toBe('overloaded')
    expect(result.isRetryable).toBe(true)
  })

  it('classifies HTTP 500 as server error (retryable)', () => {
    const err = { status: 500, message: 'Internal Server Error' }
    const result = classifyError(err)
    expect(result.type).toBe('server')
    expect(result.isRetryable).toBe(true)
  })

  it('classifies HTTP 401 as auth error (not retryable)', () => {
    const err = { status: 401, message: 'Unauthorized' }
    const result = classifyError(err)
    expect(result.type).toBe('auth')
    expect(result.isRetryable).toBe(false)
  })

  it('classifies Anthropic SSE error on status 200 with error.type=overloaded_error', () => {
    const err = { status: 200, error: { type: 'overloaded_error', message: 'Overloaded' } }
    const result = classifyError(err)
    expect(result.type).toBe('overloaded')
    expect(result.isRetryable).toBe(true)
  })

  it('classifies Anthropic SSE error with error.type=rate_limit_error', () => {
    const err = { status: 200, error: { type: 'rate_limit_error', message: 'Rate limit exceeded' } }
    const result = classifyError(err)
    expect(result.type).toBe('rate_limit')
    expect(result.isRetryable).toBe(true)
  })

  it('classifies AbortError as not retryable', () => {
    const err = { name: 'AbortError', message: 'The operation was aborted' }
    const result = classifyError(err)
    expect(result.type).toBe('unknown')
    expect(result.isRetryable).toBe(false)
  })

  it('classifies unknown error as not retryable', () => {
    const err = new Error('something went wrong')
    const result = classifyError(err)
    expect(result.type).toBe('unknown')
    expect(result.isRetryable).toBe(false)
  })

  it('classifies prompt too long error (status 400 with message)', () => {
    const err = { status: 400, error: { error: { message: 'prompt is too long' } } }
    const result = classifyError(err)
    expect(result.type).toBe('prompt_too_long')
    expect(result.isRetryable).toBe(false)
  })
})

describe('isRetryableError', () => {
  it('treats Anthropic SDK APIConnectionError as retryable', () => {
    expect(isRetryableError(makeAnthropicConnectionError())).toBe(true)
  })

  it('treats undici "fetch failed" as retryable', () => {
    expect(isRetryableError(makeFetchFailedError())).toBe(true)
  })

  it('still treats auth errors as not retryable', () => {
    expect(isRetryableError({ status: 401, message: 'Unauthorized' })).toBe(false)
  })
})

describe('DEFAULT_MAX_STREAM_RETRIES', () => {
  it('defaults to 5', () => {
    expect(DEFAULT_MAX_STREAM_RETRIES).toBe(5)
  })
})

describe('getStreamRetryDelay', () => {
  it('uses rate_limit config: base 3s, max 60s', () => {
    const d0 = getStreamRetryDelay(0, 'rate_limit')
    expect(d0).toBeGreaterThanOrEqual(2250)
    expect(d0).toBeLessThanOrEqual(3750)

    const d2 = getStreamRetryDelay(2, 'rate_limit')
    expect(d2).toBeGreaterThanOrEqual(9000)
    expect(d2).toBeLessThanOrEqual(60000)
  })

  it('uses connection config: base 1s, max 15s', () => {
    const d0 = getStreamRetryDelay(0, 'connection')
    expect(d0).toBeGreaterThanOrEqual(750)
    expect(d0).toBeLessThanOrEqual(1250)
  })

  it('uses overloaded config: base 2s, max 30s', () => {
    const d0 = getStreamRetryDelay(0, 'overloaded')
    expect(d0).toBeGreaterThanOrEqual(1500)
    expect(d0).toBeLessThanOrEqual(2500)
  })

  it('falls back to server config for unknown type', () => {
    const d0 = getStreamRetryDelay(0, 'unknown_type')
    expect(d0).toBeGreaterThanOrEqual(1500)
    expect(d0).toBeLessThanOrEqual(2500)
  })
})

describe('parseRetryAfter', () => {
  it('parses Retry-After-MS header', () => {
    const headers = new Headers({ 'Retry-After-MS': '5000' })
    expect(parseRetryAfter(headers)).toBe(5000)
  })

  it('parses Retry-After as seconds', () => {
    const headers = new Headers({ 'Retry-After': '10' })
    expect(parseRetryAfter(headers)).toBe(10000)
  })

  it('parses Retry-After as HTTP Date', () => {
    const futureDate = new Date(Date.now() + 15000).toUTCString()
    const headers = new Headers({ 'Retry-After': futureDate })
    const result = parseRetryAfter(headers)
    expect(result).toBeGreaterThan(10000)
    expect(result).toBeLessThan(20000)
  })

  it('returns null when no header', () => {
    const headers = new Headers({})
    expect(parseRetryAfter(headers)).toBeNull()
  })

  it('returns null for invalid Retry-After-MS value', () => {
    const headers = new Headers({ 'Retry-After-MS': 'abc' })
    expect(parseRetryAfter(headers)).toBeNull()
  })

  it('returns null for negative Retry-After-MS', () => {
    const headers = new Headers({ 'Retry-After-MS': '-5' })
    expect(parseRetryAfter(headers)).toBeNull()
  })

  it('handles zero Retry-After-MS as invalid', () => {
    const headers = new Headers({ 'Retry-After-MS': '0' })
    expect(parseRetryAfter(headers)).toBeNull()
  })
})

describe('withStreamRetry', () => {
  it('yields all chunks from successful generator', async () => {
    async function* mockStream(): AsyncGenerator<StreamChunk> {
      yield { type: 'text', index: 0, delta: 'hello' }
      yield { type: 'text', index: 0, delta: ' world' }
      yield { type: 'done', index: -1 }
    }

    const results: (StreamChunk | RetryEvent)[] = []
    for await (const item of withStreamRetry(mockStream, {
      maxRetries: 3,
      classify: classifyError,
      getDelay: getStreamRetryDelay,
    })) {
      results.push(item)
    }

    expect(results).toHaveLength(3)
    expect(results[0]).toEqual({ type: 'text', index: 0, delta: 'hello' })
    expect(results[2]).toEqual({ type: 'done', index: -1 })
  })

  it('retries on connection error before first chunk, yields RetryEvent, then streams', async () => {
    let callCount = 0
    async function* mockStream(): AsyncGenerator<StreamChunk> {
      callCount++
      if (callCount === 1) {
        // First attempt: throw on first .next() (connection establishment failure)
        throw { code: 'ECONNRESET', message: 'read ECONNRESET' }
      }
      // Second attempt: succeeds
      yield { type: 'text', index: 0, delta: 'ok' }
      yield { type: 'done', index: -1 }
    }

    const results: (StreamChunk | RetryEvent)[] = []
    for await (const item of withStreamRetry(mockStream, {
      maxRetries: 3,
      classify: classifyError,
      getDelay: () => 10, // instant for test
    })) {
      results.push(item)
    }

    expect(callCount).toBe(2)
    const retryEvent = results.find(r => (r as any).type === 'retry') as RetryEvent
    expect(retryEvent).toBeDefined()
    expect(retryEvent.attempt).toBe(1)
    expect(retryEvent.errorType).toBe('connection')

    // No partial chunks from the failed attempt (error happened before first chunk)
    const textChunks = results.filter(r => r.type === 'text') as StreamChunk[]
    expect(textChunks).toHaveLength(1)
    expect(textChunks[0].delta).toBe('ok')

    // RetryEvent comes BEFORE any successful chunk
    const retryIndex = results.findIndex(r => (r as any).type === 'retry')
    const okIndex = results.findIndex(r => r.type === 'text' && (r as StreamChunk).delta === 'ok')
    expect(retryIndex).toBeLessThan(okIndex)
  })

  it('retries on wrapped APIConnectionError before first chunk', async () => {
    let callCount = 0
    async function* mockStream(): AsyncGenerator<StreamChunk> {
      callCount++
      if (callCount === 1) throw makeAnthropicConnectionError()
      yield { type: 'text', index: 0, delta: 'ok' }
      yield { type: 'done', index: -1 }
    }

    const results: (StreamChunk | RetryEvent)[] = []
    for await (const item of withStreamRetry(mockStream, {
      maxRetries: 3,
      classify: classifyError,
      getDelay: () => 10,
    })) {
      results.push(item)
    }

    expect(callCount).toBe(2)
    const retryEvent = results.find(r => (r as any).type === 'retry') as RetryEvent
    expect(retryEvent).toBeDefined()
    expect(retryEvent.errorType).toBe('connection')
  })

  it('does NOT retry mid-stream errors (first chunk succeeds, later error propagates)', async () => {
    let callCount = 0
    async function* mockStream(): AsyncGenerator<StreamChunk> {
      callCount++
      yield { type: 'text', index: 0, delta: 'partial' } // first chunk OK → committed
      throw { code: 'ECONNRESET', message: 'mid-stream blip' }
    }

    const results: (StreamChunk | RetryEvent)[] = []
    let caughtErr: any
    try {
      for await (const item of withStreamRetry(mockStream, {
        maxRetries: 3,
        classify: classifyError,
        getDelay: () => 10,
      })) {
        results.push(item)
      }
    } catch (err) {
      caughtErr = err
    }

    // Only one attempt — mid-stream errors are not retried
    expect(callCount).toBe(1)
    // The partial chunk that got through before the error is kept
    const textChunks = results.filter(r => r.type === 'text') as StreamChunk[]
    expect(textChunks).toHaveLength(1)
    expect(textChunks[0].delta).toBe('partial')
    // No retry event
    expect(results.find(r => (r as any).type === 'retry')).toBeUndefined()
    // Error propagated to caller
    expect(caughtErr).toMatchObject({ code: 'ECONNRESET' })
  })

  it('throws on non-retryable error without retrying', async () => {
    async function* mockStream(): AsyncGenerator<StreamChunk> {
      yield { type: 'text', index: 0, delta: 'partial' }
      throw { status: 401, message: 'Unauthorized' }
    }

    await expect(async () => {
      for await (const _ of withStreamRetry(mockStream, {
        maxRetries: 3,
        classify: classifyError,
        getDelay: () => 10,
      })) {}
    }).rejects.toMatchObject({ status: 401 })
  })

  it('throws after maxRetries exhausted', async () => {
    async function* mockStream(): AsyncGenerator<StreamChunk> {
      throw { code: 'ECONNRESET', message: 'reset' }
    }

    await expect(async () => {
      for await (const _ of withStreamRetry(mockStream, {
        maxRetries: 2,
        classify: classifyError,
        getDelay: () => 10,
      })) {}
    }).rejects.toMatchObject({ code: 'ECONNRESET' })
  })

  it('respects abortSignal', async () => {
    const controller = new AbortController()
    async function* mockStream(): AsyncGenerator<StreamChunk> {
      throw { code: 'ECONNRESET', message: 'reset' }
    }

    setTimeout(() => controller.abort(), 50)

    await expect(async () => {
      for await (const _ of withStreamRetry(mockStream, {
        maxRetries: 10,
        classify: classifyError,
        getDelay: () => 1000,
        abortSignal: controller.signal,
      })) {}
    }).rejects.toThrow()
  })
})

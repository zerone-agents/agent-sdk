/**
 * Retry Logic with Exponential Backoff
 *
 * Handles API retries for rate limits, overloaded servers,
 * and transient failures.
 */

/**
 * Retry configuration.
 */
export interface RetryConfig {
  maxRetries: number
  baseDelayMs: number
  maxDelayMs: number
  retryableStatusCodes: number[]
}

/**
 * Default retry configuration.
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 2000,
  maxDelayMs: 30000,
  // Note: 429 (rate limit) is intentionally NOT retried — it fails fast
  // so callers can surface the error instead of waiting through backoff.
  retryableStatusCodes: [500, 502, 503, 529],
}

/**
 * Check if an error is retryable.
 */
/**
 * Error codes that indicate a network-level failure worth retrying.
 */
const CONNECTION_ERROR_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
])

/**
 * Walk the `cause` chain looking for a network error code.
 * SDKs wrap socket errors (e.g. Anthropic's APIConnectionError →
 * TypeError('fetch failed') → Error with code ENOTFOUND), so the code
 * is rarely on the top-level error.
 */
export function findConnectionErrorCode(err: any, depth = 0): string | undefined {
  if (!err || depth > 5) return undefined
  if (typeof err.code === 'string' && CONNECTION_ERROR_CODES.has(err.code)) return err.code
  return findConnectionErrorCode(err.cause, depth + 1)
}

/**
 * Check whether an error represents a network disconnection,
 * including SDK-wrapped errors (APIConnectionError, undici fetch failures).
 */
export function isConnectionError(err: any): boolean {
  if (findConnectionErrorCode(err)) return true
  // undici network failure without an identifiable cause code
  if (err?.name === 'TypeError' && err?.message === 'fetch failed') return true
  // @anthropic-ai/sdk APIConnectionError / APIConnectionTimeoutError.
  // These extend Error without setting `name`, so match the fixed
  // messages and the constructor name as well.
  if (err?.message === 'Connection error.' || err?.message === 'Request timed out.') return true
  if (err?.constructor?.name === 'APIConnectionError' || err?.constructor?.name === 'APIConnectionTimeoutError') {
    return true
  }
  return false
}

export function isRetryableError(err: any, config: RetryConfig = DEFAULT_RETRY_CONFIG): boolean {
  if (err?.status && config.retryableStatusCodes.includes(err.status)) {
    return true
  }

  // Network errors (including SDK-wrapped ones)
  if (isConnectionError(err)) {
    return true
  }

  // API overloaded
  if (err?.error?.type === 'overloaded_error') {
    return true
  }

  return false
}

/**
 * Calculate delay for exponential backoff.
 */
export function getRetryDelay(attempt: number, config: RetryConfig = DEFAULT_RETRY_CONFIG): number {
  const delay = config.baseDelayMs * Math.pow(2, attempt)
  // Add jitter (±25%)
  const jitter = delay * 0.25 * (Math.random() * 2 - 1)
  return Math.min(delay + jitter, config.maxDelayMs)
}

/**
 * Execute a function with retries.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  abortSignal?: AbortSignal,
): Promise<T> {
  let lastError: any

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    if (abortSignal?.aborted) {
      throw new Error('Aborted')
    }

    try {
      return await fn()
    } catch (err: any) {
      lastError = err

      if (!isRetryableError(err, config)) {
        throw err
      }

      if (attempt === config.maxRetries) {
        throw err
      }

      // Wait before retry
      const delay = getRetryDelay(attempt, config)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }

  throw lastError
}

/**
 * Check if an error is a "prompt too long" error.
 */
export function isPromptTooLongError(err: any): boolean {
  if (err?.status === 413) return true
  if (err?.status === 400) {
    const message = err?.error?.error?.message || err?.message || ''
    return message.includes('prompt is too long') ||
      message.includes('max_tokens') ||
      message.includes('context length') ||
      message.includes('max bytes to request body') ||
      message.includes('TooLarge')
  }
  return false
}

/**
 * Check if error is an auth error.
 */
export function isAuthError(err: any): boolean {
  return err?.status === 401 || err?.status === 403
}

/**
 * Check if error is a rate limit error.
 */
export function isRateLimitError(err: any): boolean {
  return err?.status === 429
}

/**
 * Format an API error for display.
 */
export function formatApiError(err: any): string {
  if (isAuthError(err)) {
    return 'Authentication failed. Check your ZERONE_AGENT_API_KEY.'
  }
  if (isRateLimitError(err)) {
    return 'Rate limit exceeded. Please retry after a short wait.'
  }
  if (err?.status === 529) {
    return 'API overloaded. Please retry later.'
  }
  if (isPromptTooLongError(err)) {
    return 'Prompt too long. Auto-compacting conversation...'
  }
  return `API error: ${err.message || err}`
}

// ============================================================================
// Stream Retry: Error Classification + Layered Backoff
// ============================================================================

export interface ErrorClassification {
  type: 'connection' | 'rate_limit' | 'overloaded' | 'server' | 'auth' | 'prompt_too_long' | 'unknown'
  isRetryable: boolean
  retryAfterMs: number | null
  message: string
}

const RETRY_CONFIGS: Record<string, { baseMs: number; factor: number; maxMs: number }> = {
  overloaded:   { baseMs: 2000, factor: 2, maxMs: 30000 },
  server:       { baseMs: 2000, factor: 2, maxMs: 30000 },
  connection:   { baseMs: 1000, factor: 2, maxMs: 15000 },
}

export function getStreamRetryDelay(attempt: number, errorType: string): number {
  const config = RETRY_CONFIGS[errorType] ?? RETRY_CONFIGS.server
  const delay = config.baseMs * Math.pow(config.factor, attempt)
  const jitter = delay * 0.25 * (Math.random() * 2 - 1)
  return Math.min(delay + jitter, config.maxMs)
}

export function parseRetryAfter(headers: Headers): number | null {
  const ms = headers.get('Retry-After-MS')
  if (ms) {
    const v = parseFloat(ms)
    if (!isNaN(v) && v > 0) {
      return v
    }
  }

  const sec = headers.get('Retry-After')
  if (sec) {
    const v = parseFloat(sec)
    if (!isNaN(v) && v > 0) {
      return v * 1000
    }
    const t = Date.parse(sec)
    if (!isNaN(t)) {
      return Math.max(0, t - Date.now())
    }
  }
  return null
}

export function classifyError(err: any): ErrorClassification {
  if (err?.name === 'AbortError' || err?.message === 'Aborted') {
    return { type: 'unknown', isRetryable: false, retryAfterMs: null, message: err.message ?? '' }
  }

  let status = err?.status
  if (status === 200 && err?.error?.type) {
    const sseMap: Record<string, number> = { overloaded_error: 529, rate_limit_error: 429, api_error: 500 }
    status = sseMap[err.error.type] ?? status
  }

  let retryAfterMs: number | null = null
  const headers = err?.response?.headers
  if (headers instanceof Headers) {
    retryAfterMs = parseRetryAfter(headers)
  }

  if (isConnectionError(err)) {
    return { type: 'connection', isRetryable: true, retryAfterMs, message: err.message ?? '' }
  }

  switch (status) {
    case 429: return { type: 'rate_limit', isRetryable: false, retryAfterMs, message: err.message ?? '' }
    case 529: return { type: 'overloaded', isRetryable: true, retryAfterMs, message: err.message ?? '' }
    case 500: case 502: case 503:
      return { type: 'server', isRetryable: true, retryAfterMs, message: err.message ?? '' }
    case 401: case 403:
      return { type: 'auth', isRetryable: false, retryAfterMs: null, message: err.message ?? '' }
    case 413:
      return { type: 'prompt_too_long', isRetryable: false, retryAfterMs: null, message: err.message ?? '' }
  }

  if (status === 400) {
    const msg = err?.error?.error?.message || err?.message || ''
    if (msg.includes('prompt is too long') || msg.includes('context length') || msg.includes('max_tokens')) {
      return { type: 'prompt_too_long', isRetryable: false, retryAfterMs: null, message: msg }
    }
  }

  if (err?.error?.type === 'overloaded_error') {
    return { type: 'overloaded', isRetryable: true, retryAfterMs, message: err.message ?? '' }
  }
  if (err?.error?.type === 'rate_limit_error') {
    return { type: 'rate_limit', isRetryable: false, retryAfterMs, message: err.message ?? '' }
  }

  return { type: 'unknown', isRetryable: false, retryAfterMs: null, message: err.message ?? String(err) }
}

// ============================================================================
// Stream Retry Async Generator
// ============================================================================

export type RetryEvent = {
  type: 'retry'
  attempt: number
  errorType: string
  delayMs: number
}

/**
 * Default maximum number of stream retry attempts (after the initial try).
 */
export const DEFAULT_MAX_STREAM_RETRIES = 5

/**
 * Retry only during connection establishment (before first chunk).
 * Once the first chunk arrives, errors propagate and partial chunks are kept.
 */
export async function* withStreamRetry<T extends { type: string }>(
  fn: () => AsyncGenerator<T>,
  options: {
    maxRetries: number
    classify: (err: any) => ErrorClassification
    getDelay: (attempt: number, errorType: string) => number
    abortSignal?: AbortSignal
  },
): AsyncGenerator<T | RetryEvent> {
  let attempt = 0
  let gen: AsyncGenerator<T>

  // Phase 1: establish stream, retry on failure
  while (true) {
    if (options.abortSignal?.aborted) throw new Error('Aborted')

    gen = fn()
    try {
      const first = await gen.next()
      if (!first.done) yield first.value
      break
    } catch (err) {
      if (options.abortSignal?.aborted) throw err

      const classification = options.classify(err)
      if (!classification.isRetryable) throw err
      if (attempt >= options.maxRetries) throw err

      const delay = classification.retryAfterMs
        ?? options.getDelay(attempt, classification.type)

      yield {
        type: 'retry',
        attempt: attempt + 1,
        errorType: classification.type,
        delayMs: delay,
      }

      await new Promise((resolve) => setTimeout(resolve, delay))
      attempt++
    }
  }

  // Phase 2: stream rest without retry
  yield* gen
}

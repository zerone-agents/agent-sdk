/**
 * Diagnostics sink (#78): host-injectable diagnostics surface owning ALL SDK
 * diagnostic output, plus the #77/#81 sanitize trio (and TimeoutError)
 * promoted from `mcp/client.ts` — which re-exports them for module-level
 * compat. Nothing here touches the package root except the sink types below.
 */

import type { Logger, LogLevel } from './logger.js'

const LEVEL_RANK: Record<LogLevel, number> = { error: 0, debug: 1, trace: 2 }

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TimeoutError'
  }
}

/**
 * Single-line, injection-safe representation of a log field (issue #77).
 * JSON.stringify escapes every control character (incl. \n, \r, C0/C1) and
 * adds explicit quote boundaries; over-length values are truncated. Underlying
 * Error.message never enters logs — this only sanitizes host-chosen fields
 * like the server name.
 */
export function sanitizeLogField(value: string, maxLength = 128): string {
  const s = JSON.stringify(value).replace(
    // JSON.stringify leaves C1 controls (U+0080–U+009F) and U+2028/U+2029
    // raw — all render as line breaks, so escape them explicitly (issue #81).
    /[\u0080-\u009f\u2028\u2029]/g,
    (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'),
  )
  return s.length > maxLength ? s.slice(0, maxLength - 2) + '…"' : s
}

/**
 * Stable, non-sensitive error-type diagnostic for logs (issue #81, review R1).
 * NEVER derives the logged string from error-controlled data: Error.name is
 * mutable (an identifier-shaped credential like sk_live_… passes any shape
 * check) and can even be a throwing getter — which would break the
 * error-connection return contract when log-argument evaluation throws.
 * Maps to SDK-owned constants via instanceof against SDK-known classes; the
 * try/catch additionally guards instanceof traps (Proxy getPrototypeOf can
 * throw too), making this helper total.
 */
export function stableErrorType(err: unknown): string {
  try {
    if (err instanceof TimeoutError) return 'TimeoutError'
    if (err instanceof Error) return 'Error'
    return typeof err
  } catch {
    return 'Error'
  }
}

/**
 * Total error normalization for catch blocks (issue #81, review R2).
 * `err instanceof Error` and `String(err)` can BOTH throw (a revoked Proxy
 * triggers their traps) — an unprotected normalization makes the catcher
 * itself throw, breaking the error-connection return contract. The fallback
 * message is an SDK-owned constant, never derived from the thrown value.
 */
export function normalizeCaughtError(err: unknown): Error {
  try {
    if (err instanceof Error) return err
    return new Error(String(err))
  } catch {
    return new Error('connection attempt threw a non-stringifiable value')
  }
}

/**
 * Host-injectable diagnostics sink (#78) — a `Logger` superset.
 *
 * - `fields` carries SAFE summaries only (the default implementation prints
 *   them as the second console argument, byte-preserving existing output).
 * - `cause` is the RAW error for the host's own consumption — the default
 *   implementation NEVER prints it. This is the explicit boundary between
 *   "safe summary" and "raw error for the caller to handle" (#78 contract).
 */
export interface DiagnosticsSink extends Logger {
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>, cause?: unknown): void
  /** Covariant narrowing: deriving a child sink must not lose the channel. */
  child(fields: Record<string, unknown>): DiagnosticsSink
}

/**
 * Adapt any Logger into a DiagnosticsSink. Sink-shaped loggers (anything
 * with a `warn` method) pass through by identity; plain Loggers degrade —
 * `warn` falls back to `error`, and `cause` is dropped. Returned view only
 * delegates; no state is copied or shared.
 */
export function adaptToDiagnosticsSink(logger: Logger): DiagnosticsSink {
  if (typeof (logger as DiagnosticsSink).warn === 'function') {
    return logger as DiagnosticsSink
  }
  return {
    debug: (msg, ...args) => logger.debug(msg, ...args),
    trace: (msg, ...args) => logger.trace(msg, ...args),
    warn: (msg, fields) => logger.error(msg, fields),
    error: (msg, fields) => logger.error(msg, fields),
    child: (fields) => adaptToDiagnosticsSink(logger.child(fields)),
  }
}

function prefixedSink(prefix: string, level: LogLevel): DiagnosticsSink {
  const enabled = (l: LogLevel) => LEVEL_RANK[level] >= LEVEL_RANK[l]
  const p = (msg: string) => (prefix ? `${prefix} ${msg}` : msg)
  return {
    debug: (msg, ...args) => { if (enabled('debug')) console.debug(p(msg), ...args) },
    trace: (msg, ...args) => { if (enabled('trace')) console.debug(p(msg), ...args) },
    warn: (msg, fields) => {
      if (fields !== undefined) console.warn(p(msg), fields)
      else console.warn(p(msg))
    },
    error: (msg, fields) => {
      if (fields !== undefined) console.error(p(msg), fields)
      else console.error(p(msg)) // cause is NEVER printed (#78 contract)
    },
    child: (fields) =>
      prefixedSink(
        [prefix, Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ')]
          .filter(Boolean).join(' '),
        level,
      ),
  }
}

/**
 * Console-backed default sink (#78). Byte rules: no prefix injection at the
 * root (call sites keep their full existing message strings), `fields` prints
 * as the second console argument only when defined, `cause` never prints.
 * `warn`/`error` always emit; `debug`/`trace` follow the given LogLevel
 * (default 'debug', matching the engine logger's default).
 */
export function createDiagnosticsSink(options?: { level?: LogLevel }): DiagnosticsSink {
  return prefixedSink('', options?.level ?? 'debug')
}

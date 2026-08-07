/**
 * Lightweight logger abstraction.
 *
 * Provides a minimal interface (debug, trace, error, child) over `console`,
 * so modules can be tested with mock loggers and don't depend on a
 * specific logging library.
 *
 * Log levels:
 * - `error` — only errors are printed
 * - `debug` (default) — errors only; tool metadata/input are silent
 * - `trace`  — everything, including tool-start metadata and redacted
 *   input previews
 */

export type LogLevel = 'error' | 'debug' | 'trace'

export interface Logger {
  debug(msg: string, ...args: unknown[]): void
  trace(msg: string, ...args: unknown[]): void
  error(msg: string, ...args: unknown[]): void
  child(fields: Record<string, unknown>): Logger
}

const LEVEL_RANK: Record<LogLevel, number> = { error: 0, debug: 1, trace: 2 }

function makeLogger(prefix: string, level: LogLevel): Logger {
  const enabled = (l: LogLevel) => LEVEL_RANK[level] >= LEVEL_RANK[l]
  return {
    debug(msg: string, ...args: unknown[]) {
      if (enabled('debug')) console.debug(`${prefix} ${msg}`, ...args)
    },
    trace(msg: string, ...args: unknown[]) {
      if (enabled('trace')) console.debug(`${prefix} ${msg}`, ...args)
    },
    error(msg: string, ...args: unknown[]) {
      console.error(`${prefix} ${msg}`, ...args)
    },
    child(fields: Record<string, unknown>): Logger {
      const fieldStr = Object.entries(fields)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ')
      const childPrefix = [prefix, fieldStr].filter(Boolean).join(' ')
      return makeLogger(childPrefix, level)
    },
  }
}

/**
 * Create a console-backed logger with an optional component prefix.
 *
 * `child()` returns a new logger that prepends the parent prefix plus
 * any extra fields to every message, and inherits the parent's level.
 *
 * Defaults to level `debug` (silent — only `error` prints). Pass
 * `{ level: 'trace' }` to enable tool-start metadata + redacted input
 * previews.
 */
export function createLogger(
  component?: string,
  options?: { level?: LogLevel },
): Logger {
  const prefix = component ? `[${component}]` : ''
  return makeLogger(prefix, options?.level ?? 'debug')
}

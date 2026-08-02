/**
 * Lightweight logger abstraction.
 *
 * Provides a minimal interface (debug, error, child) over `console`,
 * so modules can be tested with mock loggers and don't depend on a
 * specific logging library.
 */

export interface Logger {
  debug(msg: string, ...args: unknown[]): void
  error(msg: string, ...args: unknown[]): void
  child(fields: Record<string, unknown>): Logger
}

function makeLogger(prefix: string): Logger {
  return {
    debug(msg: string, ...args: unknown[]) {
      console.debug(`${prefix} ${msg}`, ...args)
    },
    error(msg: string, ...args: unknown[]) {
      console.error(`${prefix} ${msg}`, ...args)
    },
    child(fields: Record<string, unknown>): Logger {
      const fieldStr = Object.entries(fields)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ')
      const childPrefix = [prefix, fieldStr].filter(Boolean).join(' ')
      return makeLogger(childPrefix)
    },
  }
}

/**
 * Create a console-backed logger with an optional component prefix.
 *
 * `child()` returns a new logger that prepends the parent prefix plus
 * any extra fields to every message.
 */
export function createLogger(component?: string): Logger {
  const prefix = component ? `[${component}]` : ''
  return makeLogger(prefix)
}

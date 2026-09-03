import type { CronExecution, CronScheduleSnapshot, CronTask } from './types.js'

export type CronEvent =
  | { type: 'taskCreated'; task: CronTask }
  | { type: 'taskUpdated'; task: CronTask }
  | { type: 'taskDeleted'; taskId: string }
  | { type: 'scheduleUpdated'; snapshots: CronScheduleSnapshot[] }
  | { type: 'executionStarted'; execution: CronExecution }
  | { type: 'executionCompleted'; execution: CronExecution }

/**
 * Observational event sink. Sinks MUST NOT affect task or execution state:
 * `emitCronEvent` swallows sink errors (diagnostics only). Hosts (e.g.
 * Zerone) bridge this to WebSocket publishing.
 */
export type CronEventSink = (event: CronEvent) => void | Promise<void>

import { stableErrorType, type DiagnosticsSink } from '../utils/diagnostics.js'

export const noopEventSink: CronEventSink = () => {}

/** Diagnostics channel: reported, never thrown, never alters state.
 *  `cause` carries the RAW error for the host (#78 R1); single-param
 *  implementations remain assignable (extra args are ignored). */
export type CronDiagnosticSink = (message: string, cause?: unknown) => void

export const consoleDiagnosticSink: CronDiagnosticSink = (message) => {
  console.warn(`[cron] ${message}`)
}

/**
 * #78: compose the cron diagnostics channel from the richer sink options.
 * Precedence: `diagnostics` (DiagnosticsSink — messages bridge to
 * `sink.warn('[cron] <message>')`) wins over the legacy string-sink
 * `onDiagnostic`; neither → console default. Pure function, no global state.
 */
export function resolveCronDiagnosticSink(options: {
  diagnostics?: DiagnosticsSink
  onDiagnostic?: CronDiagnosticSink
}): CronDiagnosticSink {
  if (options.diagnostics) {
    return (message, cause) =>
      options.diagnostics!.warn(
        `[cron] ${message}`,
        cause !== undefined ? { errorType: stableErrorType(cause) } : undefined,
        cause,
      )
  }
  return options.onDiagnostic ?? consoleDiagnosticSink
}

/**
 * Best-effort diagnostic delivery: the diagnostics channel itself must never
 * throw, never reject, and never alter task/execution state (issue #42).
 */
export function reportCronDiagnostic(
  onDiagnostic: CronDiagnosticSink | undefined,
  message: string,
  cause?: unknown,
): void {
  if (!onDiagnostic) return
  try {
    // Single-arg call shape when no cause — legacy string sinks (and their
    // exact-arity assertions) observe the historical form (#78 R1).
    const result =
      cause !== undefined
        ? (onDiagnostic(message, cause) as unknown)
        : (onDiagnostic(message) as unknown)
    if (result && typeof (result as Promise<void>).then === 'function') {
      ;(result as Promise<void>).then(undefined, () => {
        // A broken (async) diagnostics sink must not propagate.
      })
    }
  } catch {
    // A broken (sync) diagnostics sink must not propagate.
  }
}

export async function emitCronEvent(
  sink: CronEventSink | undefined,
  event: CronEvent,
  onDiagnostic?: CronDiagnosticSink,
): Promise<void> {
  if (!sink) return
  try {
    await sink(event)
  } catch (err) {
    reportCronDiagnostic(onDiagnostic, 'cron event sink failed', err)
  }
}

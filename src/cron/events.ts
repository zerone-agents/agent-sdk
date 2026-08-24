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

export const noopEventSink: CronEventSink = () => {}

/** Diagnostics channel: reported, never thrown, never alters state. */
export type CronDiagnosticSink = (message: string) => void

export const consoleDiagnosticSink: CronDiagnosticSink = (message) => {
  console.warn(`[cron] ${message}`)
}

/**
 * Best-effort diagnostic delivery: the diagnostics channel itself must never
 * throw, never reject, and never alter task/execution state (issue #42).
 */
export function reportCronDiagnostic(
  onDiagnostic: CronDiagnosticSink | undefined,
  message: string,
): void {
  if (!onDiagnostic) return
  try {
    const result = onDiagnostic(message) as unknown
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
    reportCronDiagnostic(
      onDiagnostic,
      `cron event sink failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

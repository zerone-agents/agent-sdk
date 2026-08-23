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

export async function emitCronEvent(
  sink: CronEventSink | undefined,
  event: CronEvent,
): Promise<void> {
  if (!sink) return
  try {
    await sink(event)
  } catch {
    // Observational only — never propagate.
  }
}

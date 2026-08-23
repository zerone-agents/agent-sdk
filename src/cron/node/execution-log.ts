import { appendFile, readFile } from 'node:fs/promises'

import { CRON_EXECUTION_STATUSES, type CronExecution } from '../types.js'

export interface ExecutionLogRecord {
  seq: number
  execution: CronExecution
}

export interface ExecutionLogReplayResult {
  executions: Map<string, CronExecution>
  seq: number
  diagnostics: string[]
}

function isExecutionLogRecord(value: unknown): value is ExecutionLogRecord {
  if (typeof value !== 'object' || value === null) return false
  const v = value as { seq?: unknown; execution?: unknown }
  if (typeof v.seq !== 'number') return false
  const ex = v.execution
  if (typeof ex !== 'object' || ex === null) return false
  const e = ex as Record<string, unknown>
  return (
    typeof e.id === 'string' &&
    typeof e.cronTaskId === 'string' &&
    typeof e.scheduledFireTime === 'number' &&
    (e.trigger === 'scheduled' || e.trigger === 'manual') &&
    typeof e.status === 'string' &&
    CRON_EXECUTION_STATUSES.has(e.status)
  )
}

/**
 * Append-only execution state log (`executions.jsonl`). Every line is a full
 * execution snapshot; replay applies lines in order so the last snapshot per
 * execution id wins. The log is the source of truth — the derived index in
 * FileExecutionStore is always rebuildable from it.
 */
export class ExecutionLog {
  constructor(private readonly filePath: string) {}

  async append(seq: number, execution: CronExecution): Promise<void> {
    const record: ExecutionLogRecord = { seq, execution }
    await appendFile(this.filePath, `${JSON.stringify(record)}\n`, 'utf8')
  }

  async replay(): Promise<ExecutionLogReplayResult> {
    let text: string
    try {
      text = await readFile(this.filePath, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { executions: new Map(), seq: 0, diagnostics: [] }
      }
      throw err
    }

    // A torn append leaves no trailing newline; a complete line always does.
    // Only then may the last line be treated as an incomplete tail.
    const hasTrailingNewline = text.endsWith('\n')
    const lines = text.split('\n')
    // A complete file ends with \n; drop the empty trailing element.
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

    const executions = new Map<string, CronExecution>()
    const diagnostics: string[] = []
    let seq = 0
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]!
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        parsed = undefined
      }
      if (!isExecutionLogRecord(parsed)) {
        if (i === lines.length - 1 && !hasTrailingNewline) {
          // Incomplete tail: process died mid-append. Ignore + diagnose.
          diagnostics.push(`ignored incomplete trailing record at line ${i + 1}`)
          continue
        }
        // Mid-log corruption: refuse to start rather than silently lose history.
        throw new Error(
          `Execution log corrupted at line ${i + 1} in ${this.filePath}. ` +
            'Manual intervention required before restart.',
        )
      }
      seq = Math.max(seq, parsed.seq)
      executions.set(parsed.execution.id, parsed.execution)
    }
    return { executions, seq, diagnostics }
  }
}

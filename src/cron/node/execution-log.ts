import { appendFile, readFile, truncate } from 'node:fs/promises'

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

/**
 * Strict (fatal) UTF-8 decoder shared by replay() and repairTail() so the two
 * paths can never diverge on decoding semantics. Buffer#toString('utf8')
 * silently replaces invalid bytes with U+FFFD — a structurally complete
 * record containing invalid bytes would then pass validation and be
 * solidified as durable history. Invalid UTF-8 is corruption, not data.
 *
 * `ignoreBOM: true` keeps U+FEFF in the decoded output: the default strips
 * one BOM PER decode() call, so per-line decoding would silently normalize
 * EF BB BF bytes in front of ANY record — mid-log corruption the SDK never
 * writes. Keeping the BOM makes JSON.parse reject such lines, routing them
 * into the torn-tail / refuse-to-start handling instead.
 */
const strictUtf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

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

  /**
   * Physically normalizes the log tail so a later append cannot corrupt the
   * file. Replay repairs only the in-memory view — without this, the next
   * append would concatenate onto the bad bytes and the NEXT replay would
   * see an unrecoverable mid-log line. Two tail states are repaired
   * (mirroring replay's decisions exactly):
   * - torn tail (partial bytes, no trailing newline, not a valid record):
   *   truncate back to the end of the last complete line — those bytes were
   *   never a durable record;
   * - complete valid record missing the trailing newline (an uncertain
   *   append whose delimiter never landed; replay accepts it as a record):
   *   append the newline so the next record cannot concatenate onto it.
   *
   * All boundary arithmetic is BYTE-exact: the log is read as a Buffer and
   * fs.truncate() receives a true byte offset. A String-based index would be
   * a UTF-16 code-unit count, which diverges from the byte offset as soon
   * as any record contains non-ASCII text (e.g. Chinese output) — the
   * truncation would then land INSIDE a durable record (possibly mid
   * multi-byte character) and upgrade a recoverable tail into permanent
   * mid-log corruption.
   *
   * Must run before any further append; FileExecutionStore.doLoad() awaits
   * it during load, which precedes every transaction. Returns a diagnostic
   * message when a repair happened, null when the tail was already normal.
   */
  async repairTail(): Promise<string | null> {
    let bytes: Buffer
    try {
      bytes = await readFile(this.filePath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
    if (bytes.length === 0 || bytes[bytes.length - 1] === 0x0a) return null

    const lastNewline = bytes.lastIndexOf(0x0a)
    const tailBytes = bytes.subarray(lastNewline + 1)
    let parsed: unknown
    try {
      // Only the tail candidate is decoded, and only for the validity check.
      // STRICT decoding: a structurally complete record containing invalid
      // UTF-8 bytes must NOT pass as "complete valid record" — the decode
      // throws, the tail is treated as torn/invalid, and the corrupt bytes
      // are truncated away instead of being solidified with a newline.
      parsed = JSON.parse(strictUtf8Decoder.decode(tailBytes))
    } catch {
      parsed = undefined
    }
    if (isExecutionLogRecord(parsed)) {
      // Complete record missing its delimiter — complete it.
      await appendFile(this.filePath, '\n', 'utf8')
      return 'repaired log tail: appended missing newline after complete record'
    }
    // Torn tail — drop the partial bytes back to the last complete line,
    // at the true byte offset.
    await truncate(this.filePath, lastNewline + 1)
    return `repaired log tail: truncated ${tailBytes.length} bytes of torn record`
  }

  async replay(): Promise<ExecutionLogReplayResult> {
    let bytes: Buffer
    try {
      bytes = await readFile(this.filePath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { executions: new Map(), seq: 0, diagnostics: [] }
      }
      throw err
    }

    // Byte-exact line splitting (consistent with repairTail), so the two
    // paths share both the boundaries AND the strict decoding rule: each
    // line is decoded with the fatal UTF-8 decoder, and a decode failure is
    // corruption — never silently-replaced U+FFFD data.
    // A torn append leaves no trailing newline; a complete line always does.
    // Only then may the last line be treated as an incomplete tail.
    const hasTrailingNewline = bytes.length > 0 && bytes[bytes.length - 1] === 0x0a
    const lines: Buffer[] = []
    let start = 0
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 0x0a) {
        lines.push(bytes.subarray(start, i))
        start = i + 1
      }
    }
    // The segment after the last newline is the (possibly incomplete) tail;
    // empty when the file ends with a newline — no phantom empty line.
    if (start < bytes.length) lines.push(bytes.subarray(start))

    const executions = new Map<string, CronExecution>()
    const diagnostics: string[] = []
    let seq = 0
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]!
      let parsed: unknown
      try {
        parsed = JSON.parse(strictUtf8Decoder.decode(raw))
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

export interface CronTask {
  id: string
  name?: string
  cron: string
  prompt: string
  createdAt: number
  lastFiredAt?: number
  agentId?: string
}

export type CronExecutionStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'timeout'
  | 'interrupted'

export type CronExecutionTrigger = 'scheduled' | 'manual'

export interface CronExecution {
  id: string
  cronTaskId: string
  scheduledFireTime: number
  trigger: CronExecutionTrigger
  status: CronExecutionStatus
  startedAt?: number
  completedAt?: number
  output?: string
  error?: string
}

export const CRON_EXECUTION_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'running',
  'succeeded',
  'failed',
  'skipped',
  'timeout',
  'interrupted',
])

export interface CreateCronTaskInput {
  cron: string
  prompt: string
  name?: string
  agentId?: string
}

export type CronTaskChanges = Partial<
  Pick<CronTask, 'name' | 'cron' | 'prompt' | 'agentId' | 'lastFiredAt'>
>

export interface CronExecutionQuery {
  cronTaskId?: string
  status?: CronExecutionStatus
  limit?: number
  offset?: number
}

export interface CronScheduleSnapshot {
  taskId: string
  nextRunAt: number | null
}

export interface CronJitterConfig {
  recurringFrac: number
  recurringCapMs: number
}

export interface CronFields {
  minute: number[]
  hour: number[]
  dayOfMonth: number[]
  month: number[]
  dayOfWeek: number[]
}

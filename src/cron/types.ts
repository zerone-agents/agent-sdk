export interface CronTask {
  id: string
  cron: string
  prompt: string
  createdAt: number
  lastFiredAt?: number
  agentId?: string
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

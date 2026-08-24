// Core domain types
export type {
  CronExecution,
  CronExecutionQuery,
  CronExecutionStatus,
  CronExecutionTrigger,
  CronFields,
  CronJitterConfig,
  CronScheduleSnapshot,
  CronTask,
  CronTaskChanges,
  CreateCronTaskInput,
} from './types.js'
export { CRON_EXECUTION_STATUSES } from './types.js'

// Expression + jitter utilities (unchanged public API)
export { cronToHuman, computeNextCronRun, parseCronExpression } from './cron.js'
export {
  DEFAULT_CRON_JITTER_CONFIG,
  jitteredNextCronRunMs,
  jitterFrac,
} from './jitter.js'

// Clock / timer ports + deterministic test fakes
export type { CronClock, CronTimer } from './clock.js'
export {
  FakeClock,
  ManualTimer,
  systemClock,
  systemTimer,
  waitViaTimer,
} from './clock.js'

// Ports
export type { CronStorage } from './storage.js'
export type {
  ExecutionClaimInput,
  ExecutionClaimResult,
  ExecutionStatusPatch,
  ExecutionStore,
} from './execution-store.js'
export type { CronEvent, CronEventSink } from './events.js'
export { emitCronEvent, noopEventSink } from './events.js'
export type { CronAgentResolver, CronExecutor } from './executor.js'

// Kernel
export type { CronSchedulerHost } from './scheduler.js'
export { CronScheduler } from './scheduler.js'
export {
  CronExecutionCoordinator,
  CronExecutionInterruptedError,
  CronExecutionTimeoutError,
  DEFAULT_EXECUTION_TIMEOUT_MS,
} from './coordinator.js'
export type {
  CronExecutionCoordinatorDeps,
} from './coordinator.js'
export { CronRuntime } from './runtime.js'
export type { CronRuntimeState } from './runtime.js'

// Service (single entry point)
export { createCronService, DEFAULT_MAX_CRON_TASKS } from './service.js'
export type {
  CreateCronServiceOptions,
  CronRuntimeLock,
  CronService,
} from './service.js'

import type { CronExecutionCoordinator } from './coordinator.js'
import type { CronScheduler } from './scheduler.js'

export type CronRuntimeState = 'stopped' | 'running' | 'suspended'

/**
 * Lifecycle composition of Scheduler + Coordinator. Owns the
 * stopped/running/suspended state machine; understands nothing about
 * storage backends, agents, or events.
 */
export class CronRuntime {
  private state: CronRuntimeState = 'stopped'

  constructor(
    private readonly deps: { scheduler: CronScheduler; coordinator: CronExecutionCoordinator },
  ) {}

  getState(): CronRuntimeState {
    return this.state
  }

  async start(): Promise<void> {
    if (this.state !== 'stopped') return
    // Coordinator first: recover leftover executions before scheduling fires.
    await this.deps.coordinator.start()
    await this.deps.scheduler.start()
    this.state = 'running'
  }

  async stop(options?: { drainMs?: number }): Promise<void> {
    if (this.state === 'stopped') return
    // Scheduler first: stop accepting new fires, then drain executions.
    this.deps.scheduler.stop()
    await this.deps.coordinator.stop(options)
    this.state = 'stopped'
  }

  async suspend(): Promise<void> {
    if (this.state !== 'running') return
    this.deps.scheduler.suspend()
    await this.deps.coordinator.suspend()
    this.state = 'suspended'
  }

  async resume(): Promise<void> {
    if (this.state !== 'suspended') return
    await this.deps.scheduler.resume()
    this.state = 'running'
  }
}

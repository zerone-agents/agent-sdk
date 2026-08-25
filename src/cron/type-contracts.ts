/**
 * CI-level type contracts for the ADR 0005 cron tool scoping (issue #42 reopen).
 * Not shipped: excluded from tsconfig.build.json (see src/mcp/type-contracts.ts
 * for the precedent). `npm run typecheck` enforces these.
 */
import type { AgentOptions } from '../types.js'
import type { CronExecutionCoordinator } from './coordinator.js'
import type { ExecutionStore } from './execution-store.js'
// Public-entry contract: ExecutionClaimInput must be importable from the cron
// entry point (SDK consumers reference this first-class port contract).
import type { ExecutionClaimInput } from './index.js'
import type { CronService } from './service.js'
import type { CronTask } from './types.js'

// Positive contract: AgentOptions accepts a per-Agent cronService, which the
// Agent injects into toolServices.cron (ADR 0005 — no module-level globals).
const opts: AgentOptions = { cronService: {} as CronService }
void opts

// initCronTools must NOT return: it was removed with the module-global state.
// If a compat export is ever (re)introduced, the import below fails typecheck —
// the module-global path must stay dead.
// @ts-expect-error initCronTools no longer exists on the public surface
import { initCronTools } from '../tools/cron.js'
void initCronTools

// Claim identity is a discriminated union (issue #42, round-5 review): a
// manual claim MUST carry a custom dedupKey and a scheduled claim MUST NOT —
// the time-derived DEFAULT identity belongs to scheduled claims only, so an
// inconsistent (trigger, dedupKey) pair is unrepresentable at the interface.
const store: ExecutionStore = null as unknown as ExecutionStore
// OK: scheduled claim, DEFAULT identity.
void store.claim({ taskId: 't', scheduledFireTime: 1, trigger: 'scheduled' })
// OK: manual claim with its custom identity.
void store.claim({ taskId: 't', scheduledFireTime: 1, trigger: 'manual', dedupKey: 'manual:x' })
// @ts-expect-error a manual claim without its custom dedupKey is unrepresentable
void store.claim({ taskId: 't', scheduledFireTime: 1, trigger: 'manual' })
// @ts-expect-error a scheduled claim must not carry a custom dedupKey
void store.claim({ taskId: 't', scheduledFireTime: 1, trigger: 'scheduled', dedupKey: 'x' })

// The same contract holds at the coordinator boundary via strict overloads
// (issue #42, round-6 review). The dispatch() claim/completion split (issue
// #51) carries the SAME strict-overload contract — SDK-internal (called only
// by createCronService for enqueueNow; SubmittedExecution is deliberately
// not re-exported from the cron entry per #51's public-surface constraint).
const coordinator: CronExecutionCoordinator = null as unknown as CronExecutionCoordinator
const cronTask = null as unknown as CronTask
// OK: scheduled submission, no dedupKey.
void coordinator.submit(cronTask, 1, 'scheduled')
// OK: manual submission with its custom identity.
void coordinator.submit(cronTask, 1, 'manual', 'manual:x')
// @ts-expect-error a manual submission without a dedupKey is unrepresentable
void coordinator.submit(cronTask, 1, 'manual')
// @ts-expect-error a scheduled submission must not carry a dedupKey
void coordinator.submit(cronTask, 1, 'scheduled', 'x')
void coordinator.dispatch(cronTask, 1, 'scheduled')
void coordinator.dispatch(cronTask, 1, 'manual', 'manual:x')
// @ts-expect-error a manual dispatch without a dedupKey is unrepresentable
void coordinator.dispatch(cronTask, 1, 'manual')
// @ts-expect-error a scheduled dispatch must not carry a dedupKey
void coordinator.dispatch(cronTask, 1, 'scheduled', 'x')

// ExecutionClaimInput must be usable by SDK consumers (round-6 export fix).
const claimInput: ExecutionClaimInput = {
  taskId: 't',
  scheduledFireTime: 1,
  trigger: 'manual',
  dedupKey: 'manual:x',
}
void claimInput

// enqueueNow is a CronService HOST API (issue #51): present on the interface
// (property access fails typecheck if it is ever dropped). It is NOT an
// Agent Tool — the cron tool set stays exactly Create/Delete/List (locked by
// a runtime test in tools.test.ts).
const svc: CronService = null as unknown as CronService
void svc.enqueueNow

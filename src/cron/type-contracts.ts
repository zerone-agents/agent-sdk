/**
 * CI-level type contracts for the ADR 0005 cron tool scoping (issue #42 reopen).
 * Not shipped: excluded from tsconfig.build.json (see src/mcp/type-contracts.ts
 * for the precedent). `npm run typecheck` enforces these.
 */
import type { AgentOptions } from '../types.js'
import type { ExecutionStore } from './execution-store.js'
import type { CronService } from './service.js'

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

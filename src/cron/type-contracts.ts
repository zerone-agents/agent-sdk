/**
 * CI-level type contracts for the ADR 0005 cron tool scoping (issue #42 reopen).
 * Not shipped: excluded from tsconfig.build.json (see src/mcp/type-contracts.ts
 * for the precedent). `npm run typecheck` enforces these.
 */
import type { AgentOptions } from '../types.js'
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

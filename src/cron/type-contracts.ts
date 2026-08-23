/**
 * CI-level type contracts for the issue #42 breaking change.
 * Not shipped: excluded from tsconfig.build.json (see src/mcp/type-contracts.ts
 * for the precedent). `npm run typecheck` enforces these.
 */
import type { CronService } from './service.js'
import type { CronStorage } from './storage.js'
import { initCronTools } from '../tools/cron.js'

// Positive contract: initCronTools accepts a CronService.
const acceptsService: (service: CronService) => void = initCronTools
void acceptsService

// Negative contract: the legacy initCronTools(storage: CronStorage) call must
// NOT compile. If a compat overload is ever (re)introduced, the
// expect-error below becomes "unused" and typecheck fails — the legacy path
// must stay dead (issue #42: no overloads, no deprecated layer, no dual paths).
// @ts-expect-error CronStorage does not satisfy CronService
initCronTools({} as CronStorage)

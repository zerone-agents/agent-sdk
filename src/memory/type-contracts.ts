/**
 * CI-level type contracts for issue #61 (pattern: src/cron/type-contracts.ts).
 * Not shipped: excluded from tsconfig.build.json. `npm run typecheck` enforces.
 */
import type { AgentOptions } from '../types.js'
import type { MemoryService, MemorySession } from './types.js'
import type { ToolServices } from '../tools/services.js'
import type { MemoryImportance, MemoryScope } from './types.js'

// AgentOptions accepts a memoryService (mounted when present).
const opts: AgentOptions = { memoryService: {} as MemoryService }
void opts

// ToolServices exposes an OPTIONAL memory slot (round-2 review P2).
const services: ToolServices = null as unknown as ToolServices
const slot: MemoryService | null | undefined = services.memory
void slot

// A host constructing ToolServices WITHOUT memory keeps compiling (no breaking):
const hostServices: ToolServices = {
  askUser: null,
  findTool: { deferredTools: [], activatedTools: new Set<string>() },
  config: new Map<string, unknown>(),
  cron: null,
}
void hostServices

// Tools normalize the slot — never assume presence:
const normalized: MemoryService | null = hostServices.memory ?? null
void normalized

// Session surface: add/search/replace/remove/renderContext are present.
const session: MemorySession = null as unknown as MemorySession
void [
  session.add, session.search, session.replace, session.remove, session.renderContext,
]

// Closed unions stay closed: importance is 25|50|75|100, scope is fixed.
const importance: MemoryImportance = 50
void importance
// @ts-expect-error MemoryImportance is a closed union of 25|50|75|100
const badImportance: MemoryImportance = 60
void badImportance
// @ts-expect-error MemoryScope is fixed to global|user|workspace
const badScope: MemoryScope = 'project'
void badScope

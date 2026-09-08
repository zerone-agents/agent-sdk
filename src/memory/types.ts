export type MemoryScope = 'global' | 'user' | 'workspace'
export type MemoryStatus = 'active' | 'archived' | 'deleted'
export type MemoryImportance = 25 | 50 | 75 | 100
export type MemoryActor = 'session' | 'summary' | 'dreaming' | 'host'
export type MemoryOperation = 'create' | 'update' | 'archive' | 'restore' | 'delete' | 'purge'

export const MEMORY_SCOPES: readonly MemoryScope[] = ['global', 'user', 'workspace']
export const MEMORY_IMPORTANCE_VALUES: readonly MemoryImportance[] = [25, 50, 75, 100]

export interface MemoryRecord {
  id: string
  scope: MemoryScope
  workspaceId: string | null
  content: string
  importance: MemoryImportance
  status: MemoryStatus
  revision: number
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

export interface MemoryInvocationContext {
  actor: MemoryActor
  sessionId?: string
  /** Host-facing workspace reference (normally a cwd); resolved by bind(). */
  workspace?: string
  sourceMessageId?: string
  reason?: string
}

export interface MemoryAccessPolicy {
  /** Restricts writable scopes; never expands readable/writable workspace access. */
  writableScopes?: MemoryScope[]
}

export interface MemoryWorkspace {
  id: string
  canonicalPath: string
}

export interface MemoryBudgets {
  globalChars: number
  userChars: number
  workspaceChars: number
  auditRetention: number
}

export const DEFAULT_MEMORY_BUDGETS: MemoryBudgets = {
  globalChars: 22_000,
  userChars: 1_375,
  workspaceChars: 10_000,
  auditRetention: 200,
}

export interface MemorySessionCreateInput {
  scope: MemoryScope
  content: string
  importance: MemoryImportance
}

export interface MemoryReplaceChanges {
  content?: string
  importance?: MemoryImportance
}

export interface MemorySearchQuery {
  text: string
  limit?: number
}

export interface MemoryRecordQuery {
  scope?: MemoryScope
  workspaceId?: string | null
  status?: MemoryStatus
}

export interface MemoryAuditQuery {
  recordId?: string
  scope?: MemoryScope
  workspaceId?: string | null
  limit?: number
}

export interface MemoryAuditEvent {
  id: string
  recordId: string
  scope: MemoryScope
  workspaceId: string | null
  operation: MemoryOperation
  expectedRevision: number | null
  committedRevision: number
  beforeContent: string | null
  afterContent: string | null
  actor: MemoryActor
  sessionId?: string
  sourceMessageId?: string
  reason?: string
  committedAt: string
}

export interface MemoryMutationResult {
  /** Primary affected record; null when none remains (purge). */
  record: MemoryRecord | null
  /** Records archived as a capacity side effect of this mutation. */
  archived: MemoryRecord[]
  /** Audit events committed with this mutation. */
  audit: MemoryAuditEvent[]
}

export type MemoryMutationCommand =
  | { type: 'create'; scope: MemoryScope; workspaceId?: string | null; content: string; importance: MemoryImportance }
  | { type: 'update'; recordId: string; expectedRevision: number; changes: MemoryReplaceChanges }
  | { type: 'archive'; recordId: string; expectedRevision: number }
  | { type: 'restore'; recordId: string; expectedRevision: number }
  | { type: 'delete'; recordId: string; expectedRevision: number }
  | { type: 'purge'; recordId: string; expectedRevision: number }

export interface MemorySession {
  add(input: MemorySessionCreateInput): Promise<MemoryMutationResult>
  search(query: MemorySearchQuery): Promise<MemoryRecord[]>
  replace(recordId: string, expectedRevision: number, changes: MemoryReplaceChanges): Promise<MemoryMutationResult>
  remove(recordId: string, expectedRevision: number): Promise<MemoryMutationResult>
  renderContext(): Promise<string>
}

export interface MemoryAdministration {
  queryWorkspaces(): Promise<MemoryWorkspace[]>
  queryRecords(query: MemoryRecordQuery): Promise<MemoryRecord[]>
  mutate(command: MemoryMutationCommand, context: MemoryInvocationContext): Promise<MemoryMutationResult>
  queryAudit(query: MemoryAuditQuery): Promise<MemoryAuditEvent[]>
}

export interface MemoryService {
  start(): Promise<void>
  stop(): Promise<void>
  bind(context: MemoryInvocationContext, policy?: MemoryAccessPolicy): Promise<MemorySession>
  readonly admin: MemoryAdministration
}
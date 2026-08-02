/**
 * ToolServices — Per-agent state isolation interface
 *
 * Defines the service dependencies that each Agent instance provides
 * to its tools, replacing the current module-level global state.
 *
 * Currently, 6 tool modules (team.ts, send-message.ts, ask-user.ts,
 * tool-search.ts, plan.ts, config.ts) store state in module-level
 * variables. When multiple Agent instances coexist, these globals are
 * overwritten. ToolServices moves that state into per-agent containers.
 *
 * This file defines ONLY types, interfaces, and a factory function.
 * No tool modules are modified here — consumption happens in later tasks.
 */

import type { ToolDefinition } from '../types.js'
import type { Team } from './team.js'
import type { AgentMessage } from './send-message.js'
import type { WebSearchConfig } from './web-search.js'

// ============================================================================
// Service Types
// ============================================================================

/**
 * Team storage — wraps the per-agent team map and counter.
 *
 * Currently stored as module-level globals in team.ts:
 *   const teamStore = new Map<string, Team>()
 *   let teamCounter = 0
 */
export interface TeamStorage {
  teams: Map<string, Team>
  counter: number
}

/**
 * Message handler — send/receive/read/clear inter-agent messages.
 *
 * Currently backed by module-level globals in send-message.ts:
 *   const mailboxes = new Map<string, AgentMessage[]>()
 */
export interface MessageSender {
  send(to: string, message: AgentMessage): void
  read(agentName: string): AgentMessage[]
  broadcast(message: AgentMessage): void
  clear(): void
}

/**
 * User prompt handler — ask the user a question.
 *
 * Currently stored as module-level global in ask-user.ts:
 *   let questionHandler: ((...) => Promise<string>) | null = null
 */
export type AskUserHandler = (
  question: string,
  options: string[],
  allowMultiselect?: boolean,
) => Promise<string>

/**
 * Tool search registry — tracks deferred/lazy-loaded tools.
 *
 * Currently stored as module-level global in tool-search.ts:
 *   let deferredTools: ToolDefinition[] = []
 */
export interface ToolSearchRegistry {
  deferredTools: ToolDefinition[]
}

/**
 * Plan mode state — tracks whether the agent is in plan mode.
 *
 * Currently stored as module-level globals in plan.ts:
 *   let planModeActive = false
 *   let currentPlan: string | null = null
 */
export interface PlanState {
  active: boolean
  currentPlan: string | null
}

/**
 * Config storage — per-agent key/value configuration.
 *
 * Currently stored as module-level global in config.ts:
 *   const configStore = new Map<string, unknown>()
 */
export type ConfigState = Map<string, unknown>

// ============================================================================
// ToolServices Interface
// ============================================================================

/**
 * Per-agent tool services container.
 *
 * Each Agent instance creates its own ToolServices to provide
 * isolated state for tools that currently rely on module-level globals.
 */
export interface ToolServices {
  team: TeamStorage
  messaging: MessageSender
  askUser: AskUserHandler | null
  toolSearch: ToolSearchRegistry
  plan: PlanState
  config: ConfigState
  /** Optional WebSearch provider configuration; absent = anonymous Exa → Parallel default. */
  webSearch?: WebSearchConfig
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create an empty ToolServices with default (uninitialized) state.
 *
 * The `messaging` handler is a no-op implementation that stores messages
 * in an internal mailbox map, matching the current send-message.ts behavior.
 * Callers can replace `messaging` entirely or set `askUser` to wire up
 * interactive handlers.
 */
export function createEmptyServices(): ToolServices {
  const mailboxes = new Map<string, AgentMessage[]>()

  return {
    team: {
      teams: new Map<string, Team>(),
      counter: 0,
    },
    messaging: {
      send(to: string, message: AgentMessage): void {
        const messages = mailboxes.get(to) || []
        messages.push(message)
        mailboxes.set(to, messages)
      },
      read(agentName: string): AgentMessage[] {
        const messages = mailboxes.get(agentName) || []
        mailboxes.set(agentName, [])
        return messages
      },
      broadcast(message: AgentMessage): void {
        for (const [name] of mailboxes) {
          const messages = mailboxes.get(name) || []
          messages.push({ ...message, to: name })
          mailboxes.set(name, messages)
        }
      },
      clear(): void {
        mailboxes.clear()
      },
    },
    askUser: null,
    toolSearch: {
      deferredTools: [],
    },
    plan: {
      active: false,
      currentPlan: null,
    },
    config: new Map<string, unknown>(),
  }
}

/**
 * DefaultToolServices — Default implementation of ToolServices
 *
 * Provides per-instance state storage for tool services, ensuring each
 * Agent instance gets isolated state instead of sharing module-level globals.
 *
 * Each service property is initialized with fresh state (new Map, new objects)
 * so multiple Agent instances can coexist without interfering with each other.
 */

import type { ToolDefinition } from '../types.js'
import type {
  ToolServices,
  TeamStorage,
  MessageSender,
  AskUserHandler,
  ToolSearchRegistry,
  PlanState,
  ConfigState,
} from './services.js'
import type { Team } from './team.js'
import type { AgentMessage } from './send-message.js'
import type { WebSearchConfig } from './web-search.js'

/**
 * Default implementation of ToolServices.
 *
 * Creates isolated state for each instance, matching the current module-level
 * behavior but scoped to individual Agent instances.
 */
export class DefaultToolServices implements ToolServices {
  team: TeamStorage
  messaging: MessageSender
  askUser: AskUserHandler | null
  toolSearch: ToolSearchRegistry
  plan: PlanState
  config: ConfigState
  /** Optional WebSearch provider configuration; absent = anonymous Exa → Parallel default. */
  webSearch?: WebSearchConfig

  constructor() {
    // Initialize team storage with fresh Map and counter
    this.team = {
      teams: new Map<string, Team>(),
      counter: 0,
    }

    // Initialize messaging with internal mailbox map
    const mailboxes = new Map<string, AgentMessage[]>()
    this.messaging = {
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
    }

    // No user handler by default (non-interactive mode)
    this.askUser = null

    // Initialize tool search registry with empty array
    this.toolSearch = {
      deferredTools: [],
    }

    // Initialize plan state
    this.plan = {
      active: false,
      currentPlan: null,
    }

    // Initialize config storage
    this.config = new Map<string, unknown>()
  }
}

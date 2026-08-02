/**
 * SendMessageTool - Inter-agent messaging
 *
 * Supports plain text and structured protocol messages
 * between teammates in a multi-agent setup.
 */

import type { ToolDefinition, ToolResult, ToolContext } from '../types.js'
import type { MessageSender } from './services.js'

/**
 * Message inbox for inter-agent communication.
 */
export interface AgentMessage {
  from: string
  to: string
  content: string
  timestamp: string
  type: 'text' | 'shutdown_request' | 'shutdown_response' | 'plan_approval_response'
}

// ============================================================================
// MessageSender Helper Functions (new API)
// ============================================================================

/**
 * Read messages from a MessageSender's mailbox.
 */
export function readMailboxFromService(svc: MessageSender, agentName: string): AgentMessage[] {
  return svc.read(agentName)
}

/**
 * Write to a MessageSender's mailbox.
 */
export function writeToMailboxFromService(svc: MessageSender, agentName: string, message: AgentMessage): void {
  svc.send(agentName, message)
}

/**
 * Clear all mailboxes in a MessageSender.
 */
export function clearMailboxesInService(svc: MessageSender): void {
  svc.clear()
}

// ============================================================================
// Backward-Compatible Shim Functions (@deprecated)
// ============================================================================

/**
 * @deprecated Module-level mailbox storage is deprecated.
 * Use ToolServices.messaging instead for per-agent isolation.
 * This shim exists for backward compatibility with external callers.
 */
const legacyMailboxes = new Map<string, AgentMessage[]>()

const legacyMessaging: MessageSender = {
  send(to: string, message: AgentMessage): void {
    const messages = legacyMailboxes.get(to) || []
    messages.push(message)
    legacyMailboxes.set(to, messages)
  },
  read(agentName: string): AgentMessage[] {
    const messages = legacyMailboxes.get(agentName) || []
    legacyMailboxes.set(agentName, [])
    return messages
  },
  broadcast(message: AgentMessage): void {
    for (const [name] of legacyMailboxes) {
      const messages = legacyMailboxes.get(name) || []
      messages.push({ ...message, to: name })
      legacyMailboxes.set(name, messages)
    }
  },
  clear(): void {
    legacyMailboxes.clear()
  },
}

/**
 * Read messages from a mailbox.
 * @deprecated Use ToolServices.messaging instead. This function uses module-level global state
 * and will be removed in a future version.
 */
export function readMailbox(agentName: string): AgentMessage[] {
  return readMailboxFromService(legacyMessaging, agentName)
}

/**
 * Write to a mailbox.
 * @deprecated Use ToolServices.messaging instead. This function uses module-level global state
 * and will be removed in a future version.
 */
export function writeToMailbox(agentName: string, message: AgentMessage): void {
  writeToMailboxFromService(legacyMessaging, agentName, message)
}

/**
 * Clear all mailboxes.
 * @deprecated Use ToolServices.messaging instead. This function uses module-level global state
 * and will be removed in a future version.
 */
export function clearMailboxes(): void {
  clearMailboxesInService(legacyMessaging)
}

// ============================================================================
// SendMessageTool
// ============================================================================

export const SendMessageTool: ToolDefinition = {
  name: 'SendMessage',
  description: 'Send a message to another agent or teammate. Supports plain text and structured protocol messages.',
  inputSchema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Recipient agent name or ID. Use "*" for broadcast.' },
      content: { type: 'string', description: 'Message content' },
      type: {
        type: 'string',
        enum: ['text', 'shutdown_request', 'shutdown_response', 'plan_approval_response'],
        description: 'Message type (default: text)',
      },
    },
    required: ['to', 'content'],
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() { return 'Send a message to another agent.' },
  async call(input: any, ctx: ToolContext): Promise<ToolResult> {
    const messaging = ctx.services.messaging

    const message: AgentMessage = {
      from: 'self',
      to: input.to,
      content: input.content,
      timestamp: new Date().toISOString(),
      type: input.type || 'text',
    }

    if (input.to === '*') {
      messaging.broadcast(message)
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `Message broadcast to all agents`,
      }
    }

    messaging.send(input.to, message)
    return {
      type: 'tool_result',
      tool_use_id: '',
      content: `Message sent to ${input.to}`,
    }
  },
}

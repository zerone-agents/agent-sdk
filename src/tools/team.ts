/**
 * Team Management Tools
 *
 * TeamCreate, TeamDelete - Multi-agent team coordination.
 * Manages team composition, task lists, and inter-agent messaging.
 */

import type { ToolDefinition, ToolResult, ToolContext } from '../types.js'
import type { TeamStorage } from './services.js'

/**
 * Team definition.
 */
export interface Team {
  id: string
  name: string
  members: string[]
  leaderId: string
  taskListId?: string
  createdAt: string
  status: 'active' | 'disbanded'
}

// ============================================================================
// TeamStorage Helper Functions (new API)
// ============================================================================

/**
 * Get all teams from a TeamStorage instance.
 */
export function getAllTeamsFromStorage(storage: TeamStorage): Team[] {
  return Array.from(storage.teams.values())
}

/**
 * Get a team by ID from a TeamStorage instance.
 */
export function getTeamFromStorage(storage: TeamStorage, id: string): Team | undefined {
  return storage.teams.get(id)
}

/**
 * Clear all teams from a TeamStorage instance.
 */
export function clearTeamsInStorage(storage: TeamStorage): void {
  storage.teams.clear()
  storage.counter = 0
}

// ============================================================================
// Backward-Compatible Shim Functions (@deprecated)
// ============================================================================

/**
 * @deprecated Module-level team storage is deprecated.
 * Use ToolServices.team instead for per-agent isolation.
 * This shim exists for backward compatibility with external callers.
 */
const legacyTeamStorage: TeamStorage = {
  teams: new Map<string, Team>(),
  counter: 0,
}

/**
 * Get all teams.
 * @deprecated Use ToolServices.team instead. This function uses module-level global state
 * and will be removed in a future version.
 */
export function getAllTeams(): Team[] {
  return getAllTeamsFromStorage(legacyTeamStorage)
}

/**
 * Get a team by ID.
 * @deprecated Use ToolServices.team instead. This function uses module-level global state
 * and will be removed in a future version.
 */
export function getTeam(id: string): Team | undefined {
  return getTeamFromStorage(legacyTeamStorage, id)
}

/**
 * Clear all teams.
 * @deprecated Use ToolServices.team instead. This function uses module-level global state
 * and will be removed in a future version.
 */
export function clearTeams(): void {
  clearTeamsInStorage(legacyTeamStorage)
}

// ============================================================================
// TeamCreateTool
// ============================================================================

export const TeamCreateTool: ToolDefinition = {
  name: 'TeamCreate',
  description: 'Create a multi-agent team for coordinated work. Assigns a lead and manages member composition.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Team name' },
      members: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of agent/teammate names',
      },
      task_description: { type: 'string', description: 'Description of the team\'s mission' },
    },
    required: ['name'],
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
  async prompt() { return 'Create a team for multi-agent coordination.' },
  async call(input: any, ctx: ToolContext): Promise<ToolResult> {
    const storage = ctx.services.team
    const id = `team_${++storage.counter}`
    const team: Team = {
      id,
      name: input.name,
      members: input.members || [],
      leaderId: 'self',
      createdAt: new Date().toISOString(),
      status: 'active',
    }
    storage.teams.set(id, team)

    return {
      type: 'tool_result',
      tool_use_id: '',
      content: `Team created: ${id} "${team.name}" with ${team.members.length} members`,
    }
  },
}

// ============================================================================
// TeamDeleteTool
// ============================================================================

export const TeamDeleteTool: ToolDefinition = {
  name: 'TeamDelete',
  description: 'Disband a team and clean up resources.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Team ID to disband' },
    },
    required: ['id'],
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
  async prompt() { return 'Delete/disband a team.' },
  async call(input: any, ctx: ToolContext): Promise<ToolResult> {
    const storage = ctx.services.team
    const team = storage.teams.get(input.id)
    if (!team) {
      return { type: 'tool_result', tool_use_id: '', content: `Team not found: ${input.id}`, is_error: true }
    }

    team.status = 'disbanded'
    storage.teams.delete(input.id)

    return {
      type: 'tool_result',
      tool_use_id: '',
      content: `Team disbanded: ${team.name}`,
    }
  },
}

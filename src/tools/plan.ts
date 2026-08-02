/**
 * Plan Mode Tools
 *
 * EnterPlanMode / ExitPlanMode - Structured planning workflow.
 * Allows the agent to enter a design/planning phase before execution.
 */

import type { ToolDefinition, ToolResult, ToolContext } from '../types.js'
import type { PlanState } from './services.js'

// ============================================================================
// PlanState Helper Functions (new API)
// ============================================================================

/**
 * Check if plan mode is active in a PlanState.
 */
export function isPlanModeActiveInState(state: PlanState): boolean {
  return state.active
}

/**
 * Get the current plan from a PlanState.
 */
export function getCurrentPlanFromState(state: PlanState): string | null {
  return state.currentPlan
}

// ============================================================================
// Backward-Compatible Shim Functions (@deprecated)
// ============================================================================

/**
 * @deprecated Module-level plan state is deprecated.
 * Use ToolServices.plan instead for per-agent isolation.
 * This shim exists for backward compatibility with external callers.
 */
const legacyPlanState: PlanState = {
  active: false,
  currentPlan: null,
}

/**
 * Check if plan mode is active.
 * @deprecated Use ToolServices.plan instead. This function uses module-level global state
 * and will be removed in a future version.
 */
export function isPlanModeActive(): boolean {
  return isPlanModeActiveInState(legacyPlanState)
}

/**
 * Get the current plan.
 * @deprecated Use ToolServices.plan instead. This function uses module-level global state
 * and will be removed in a future version.
 */
export function getCurrentPlan(): string | null {
  return getCurrentPlanFromState(legacyPlanState)
}

// ============================================================================
// EnterPlanModeTool
// ============================================================================

export const EnterPlanModeTool: ToolDefinition = {
  name: 'EnterPlanMode',
  description: 'Enter plan/design mode for complex tasks. In plan mode, the agent focuses on designing the approach before executing.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
  async prompt() { return 'Enter plan mode for structured planning.' },
  async call(_input: any, ctx: ToolContext): Promise<ToolResult> {
    const planState = ctx.services.plan

    if (planState.active) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: 'Already in plan mode.',
      }
    }

    planState.active = true
    planState.currentPlan = null

    return {
      type: 'tool_result',
      tool_use_id: '',
      content: 'Entered plan mode. Design your approach before executing. Use ExitPlanMode when the plan is ready.',
    }
  },
}

// ============================================================================
// ExitPlanModeTool
// ============================================================================

export const ExitPlanModeTool: ToolDefinition = {
  name: 'ExitPlanMode',
  description: 'Exit plan mode with a completed plan. The plan will be recorded and execution can proceed.',
  inputSchema: {
    type: 'object',
    properties: {
      plan: { type: 'string', description: 'The completed plan' },
      approved: { type: 'boolean', description: 'Whether the plan is approved for execution' },
    },
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
  async prompt() { return 'Exit plan mode with a completed plan.' },
  async call(input: any, ctx: ToolContext): Promise<ToolResult> {
    const planState = ctx.services.plan

    if (!planState.active) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: 'Not in plan mode.',
        is_error: true,
      }
    }

    planState.active = false
    planState.currentPlan = input.plan || null

    const status = input.approved !== false ? 'approved' : 'pending approval'

    return {
      type: 'tool_result',
      tool_use_id: '',
      content: `Plan mode exited. Plan status: ${status}.${planState.currentPlan ? `\n\nPlan:\n${planState.currentPlan}` : ''}`,
    }
  },
}

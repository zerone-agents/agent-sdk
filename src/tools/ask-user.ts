/**
 * AskUserQuestionTool - Interactive user questions
 *
 * In SDK mode, returns a permission_request event and waits
 * for the consumer to provide an answer.
 * In non-interactive mode, returns a default or denies.
 */

import type { ToolDefinition, ToolResult, ToolContext } from '../types.js'
import type { AskUserHandler } from './services.js'

// ============================================================================
// AskUserHandler Helper Functions (new API)
// ============================================================================

/**
 * Invoke the AskUserHandler (if any) from the services.
 */
export function askUserFromService(
  svc: AskUserHandler | null,
  question: string,
  options: string[],
  allowMultiselect?: boolean,
): Promise<string> | null {
  if (!svc) return null
  return svc(question, options, allowMultiselect)
}

// ============================================================================
// Backward-Compatible Shim Functions (@deprecated)
// ============================================================================

/**
 * @deprecated Module-level question handler is deprecated.
 * Use ToolServices.askUser instead for per-agent isolation.
 * This shim exists for backward compatibility with external callers.
 */
let legacyQuestionHandler: AskUserHandler | null = null

/**
 * Set the question handler for AskUserQuestion.
 * @deprecated Use ToolServices.askUser instead. This function uses module-level global state
 * and will be removed in a future version.
 */
export function setQuestionHandler(
  handler: (question: string, options: string[], allowMultiselect?: boolean) => Promise<string>,
): void {
  legacyQuestionHandler = handler
}

/**
 * Clear the question handler.
 * @deprecated Use ToolServices.askUser = null instead. This function uses module-level global state
 * and will be removed in a future version.
 */
export function clearQuestionHandler(): void {
  legacyQuestionHandler = null
}

/**
 * Get the current question handler.
 * @deprecated Use ToolServices.askUser instead. This function uses module-level global state
 * and will be removed in a future version.
 */
export function getQuestionHandler(): AskUserHandler | null {
  return legacyQuestionHandler
}

// ============================================================================
// AskUserQuestionTool
// ============================================================================

export const AskUserQuestionTool: ToolDefinition = {
  name: 'AskUserQuestion',
  description: `Ask the user a question with required choices. When your question has clear options for the user to select, prefer this tool over asking directly in plain text.

Useful when you need the user to make a choice or provide input. For interactive sessions (stories, quizzes, games), use this tool to present each question one at a time.

Requirements:
- MUST provide at least 2 options for the user to choose from
- Call AskUserQuestion once per question — show only the current question
- After the user answers, determine the next question based on their response
- Progress step by step until all questions are completed
IMPORTANT: This tool does NOT support asking multiple questions at once. Each call asks ONE question only. If you have multiple questions, call this tool multiple times, one question per call.`,
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to ask the user. Ask only one question at a time.' },
      options: {
        type: 'array',
        items: { type: 'string' },
        minItems: 2,
        description: 'Required choices for the user to select from. Must provide at least 2 options.',
      },
      allow_multiselect: {
        type: 'boolean',
        description: 'Whether to allow multiple selections',
      },
    },
    required: ['question', 'options'],
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
  async prompt() { return 'Ask the user a question with required choices. One question at a time for interactive Q&A.' },
  async call(input: any, ctx: ToolContext): Promise<ToolResult> {
    if (!input.options || !Array.isArray(input.options) || input.options.length < 2) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: 'Error: options must be an array with at least 2 items.',
        is_error: true,
      }
    }

    const handler = ctx.services.askUser
    if (handler) {
      try {
        const answer = await handler(input.question, input.options, input.allow_multiselect)
        return {
          type: 'tool_result',
          tool_use_id: '',
          content: answer,
        }
      } catch (err: any) {
        return {
          type: 'tool_result',
          tool_use_id: '',
          content: `User declined to answer: ${err.message}`,
          is_error: true,
        }
      }
    }

    // Non-interactive: return informative message
    return {
      type: 'tool_result',
      tool_use_id: '',
      content: `[Non-interactive mode] Question: ${input.question}\nOptions: ${input.options.join(', ')}\n\nNo user available to answer. Proceeding with best judgment.`,
    }
  },
}

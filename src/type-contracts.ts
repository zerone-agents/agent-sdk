/**
 * Compile-time contracts for the AgentInput public surface (issue #60).
 *
 * This file is NOT exported and contains no runtime behavior. Its sole
 * purpose is to fail `tsc --noEmit` (CI's typecheck step) if the public
 * input seam regresses — e.g. if `Agent.query` / `Agent.prompt` / the
 * top-level `query` narrow back to `string`, or `AgentInput` stops being
 * exported from the public entry. Test files (`*.test.ts`) are excluded
 * from tsc via tsconfig.json, so the runtime tests cannot guard the type
 * contract; the type-level assertions belong here.
 *
 * Every declaration must type-check WITHOUT `as any`. `query` is imported
 * as a value only so `typeof query` can appear in type position; nothing
 * imports this file, so no runtime code results (and tsconfig.build.json
 * excludes it from dist).
 *
 * See: src/mcp/type-contracts.ts for the same pattern (PR #16), and
 * issue #63 for the broader CI test-typecheck follow-up.
 */

import { query } from './index.js'
import type { Agent, AgentInput, ContentBlockParam } from './index.js'

// ---------------------------------------------------------------------------
// AgentInput itself
// ---------------------------------------------------------------------------

// Exported from the public entry; accepts a plain string…
const _inputString: AgentInput = 'plain string'
// …and rich content blocks (text + image).
const _inputBlocks: AgentInput = [
  { type: 'text', text: 'what is in this picture?' },
  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } },
]

// ContentBlockParam remains importable from the public entry — callers
// construct blocks against the exported type.
const _textBlock: ContentBlockParam = { type: 'text', text: 'hi' }

// ---------------------------------------------------------------------------
// Agent.query / Agent.prompt
// ---------------------------------------------------------------------------

type QueryParam = Parameters<Agent['query']>[0]
const _queryBlocks: QueryParam = _inputBlocks
const _queryString: QueryParam = _inputString

type PromptParam = Parameters<Agent['prompt']>[0]
const _promptBlocks: PromptParam = _inputBlocks
const _promptString: PromptParam = _inputString

// ---------------------------------------------------------------------------
// Top-level query()
// ---------------------------------------------------------------------------

type TopLevelPrompt = Parameters<typeof query>[0]['prompt']
const _topLevelBlocks: TopLevelPrompt = _inputBlocks
const _topLevelString: TopLevelPrompt = _inputString

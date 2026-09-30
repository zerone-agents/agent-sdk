/**
 * Subagent spawn factory — shared by TaskTool and MultiTaskTool.
 *
 * Intentional design decisions (issue #72; spec 2026-09-02-subagent-capability-isolation-design.md):
 * - Agent-local capabilities isolation: the child resolves ONLY its entry's
 *   `capabilities` (connectionTools/customTools/skills/policy) on top of the
 *   Runtime-global environment — never the parent's pools. No fallback.
 * - Subagent canUseTool is allow-all: we do NOT want permission prompts
 *   interrupting a Task phase.
 * - Task and MultiTask are removed by the resolveAgentCapabilities spawn
 *   pipeline: nesting (delegation depth > 1) is forbidden by design.
 */

import type {
  AgentDefinition,
  RuntimeEnvironment,
  SDKSubagentMessage,
} from '../types.js'
import { QueryEngine } from '../engine.js'
import { resolveAgent } from '../resolve-agent.js'
import { resolvePrompt } from '../prompts/system-prompts.js'
import type { SessionStore } from '../store/session-store.js'
import type { WriteCoordinator } from '../store/coordinator.js'
import type { SessionOwnership, NewRecord } from '../store/types.js'
import { planAndCommitCompact } from '../store/compact-commit.js'

import type { DiagnosticsSink } from '../utils/diagnostics.js'

export const DEFAULT_SUBAGENT_MAX_TURNS = 10

export type SpawnSubagentMode = 'Explore' | 'General'

const EXPLORE_RESTRICTION_PROMPT = `
You are running in Explore mode. You can only read files, search code, and run non-mutating shell commands. Do NOT modify, create, or delete any files. Do NOT write or edit code. Focus on exploration and information gathering only.`

const FALLBACK_PROMPT = 'You are a helpful assistant. Complete the given task using the available tools.'

const PROPAGATED_EVENT_TYPES = ['assistant', 'partial_message', 'tool_result', 'system', 'result']

export interface SpawnSubagentOptions {
  /** Runtime-global environment inherited from the parent session (issue #72). */
  runtime: RuntimeEnvironment
  subAgents: Record<string, AgentDefinition>
  agentName?: string
  fallbackAgentId: string
  mode: SpawnSubagentMode
  prompt: string
  description: string
  toolUseId: string
  taskIndex: number
  abortSignal?: AbortSignal
  emitEvent?: (event: SDKSubagentMessage) => void
  /** #78: diagnostics sink inherited by the child engine as its logger. */
  diagnostics?: DiagnosticsSink
  /**
   * issue #131 P3: v4 SessionStore inherited by the child agent — the subagent
   * (TodoWrite/checkpoints) persists through the SAME backend as the parent,
   * isolated by the child's own sessionId. REQUIRED: no silent fallback —
   * missing wiring must fail loudly.
   */
  store: SessionStore
  /** Optional shared coordinator (defaults to one wrapping `store` in the child). */
  coordinator?: WriteCoordinator
  /**
   * issue #131 P3 R2（§2.3）：子会话 ownership——spawn 前预登记；此后子代理全部
   * 写入自动继承登记归属（root 级联删除可达子会话）。
   */
  ownership?: SessionOwnership
}

export interface SubagentRun {
  status: 'completed' | 'failed' | 'aborted'
  output: string | null
  error: string | null
  toolsUsed: string[]
  sessionId: string
  maxTurnsHit: boolean
  maxTurns: number
}

/** System prompt for a spawned subagent; Explore mode appends the restriction notice. */
export function buildSubagentSystemPrompt(
  definition: AgentDefinition,
  mode: SpawnSubagentMode,
): string {
  const base = resolvePrompt(definition.prompt) ?? FALLBACK_PROMPT
  return mode === 'Explore' ? base + '\n' + EXPLORE_RESTRICTION_PROMPT : base
}

/**
 * R2/R18：父链预登记（幂等）+ 子 ownership 构造——Task/MultiTask 共用。
 * 集中派生协议（root 不变、parent = 直接父、toolUseId 锚定派生点），防协议分叉。
 */
export async function prepareChildOwnership(
  context: { agentId: string; ownership?: SessionOwnership },
  toolUseId: string,
  coordinator: WriteCoordinator,
): Promise<SessionOwnership> {
  const parentOwnership = context.ownership ?? { rootSessionId: context.agentId }
  await coordinator.execute(context.agentId, { kind: 'register', ownership: parentOwnership })
  return {
    rootSessionId: parentOwnership.rootSessionId,
    parentSessionId: context.agentId,
    parentToolUseId: toolUseId,
  }
}

export async function runSubagent(opts: SpawnSubagentOptions): Promise<SubagentRun> {
  const agentName = opts.agentName || opts.fallbackAgentId

  const baseRun = {
    toolsUsed: [] as string[],
    sessionId: '',
    maxTurnsHit: false,
    maxTurns: DEFAULT_SUBAGENT_MAX_TURNS,
  }

  if (!agentName) {
    return {
      ...baseRun,
      status: 'failed',
      output: null,
      error: 'Error: No agent name resolved. Provide subagent_name or ensure parent agent has an agentId.',
    }
  }

  const agentDef = opts.subAgents[agentName]
  if (!agentDef) {
    const available = Object.keys(opts.subAgents)
    return {
      ...baseRun,
      status: 'failed',
      output: null,
      error: `Error: Agent "${agentName}" is not registered.${available.length > 0 ? ` Available agents: ${available.join(', ')}` : ''}`,
    }
  }

  const maxTurns = agentDef.maxTurns ?? DEFAULT_SUBAGENT_MAX_TURNS

  // Agent-local capabilities isolation (issue #72): the child pool is the
  // entry's capabilities — never the parent's. No fallback, no inheritance.
  // findTool is fresh per spawn so a subagent can never clobber the parent's
  // (or a sibling's) deferred catalog.
  const childRuntime: RuntimeEnvironment = {
    ...opts.runtime,
    toolServices: {
      ...opts.runtime.toolServices,
      findTool: { deferredTools: [], activatedTools: new Set() },
    },
  }
  const resolved = resolveAgent(
    childRuntime,
    agentDef.capabilities ?? {},
    { ...agentDef, prompt: buildSubagentSystemPrompt(agentDef, opts.mode) },
    { spawn: { mode: opts.mode }, diagnostics: opts.diagnostics },
  )

  const sessionId = crypto.randomUUID()

  // R2（§2.3）：预登记子会话——后续写入（TodoWrite/checkpoint）自动继承登记
  // 归属；级联删除自 root 可达。幂等：同归属重复 register 为 no-op。
  if (opts.ownership && opts.coordinator) {
    await opts.coordinator.execute(sessionId, { kind: 'register', ownership: opts.ownership })
  }

  const engine = new QueryEngine({
    runtime: childRuntime,
    resolved,
    agentId: agentName,
    maxTurns,
    // Intentional: subagents auto-allow all tools — a Task phase must not be
    // interrupted by permission prompts.
    canUseTool: async () => ({ behavior: 'allow' }),
    includePartialMessages: true,
    sessionId,
    store: opts.store,
    ...(opts.coordinator !== undefined ? { coordinator: opts.coordinator } : {}),
    ...(opts.ownership !== undefined ? { ownership: opts.ownership } : {}),
    abortSignal: opts.abortSignal,
    logger: opts.diagnostics, // #78: child inherits the diagnostics channel
  })

  /**
   * R13/R21（§2.3/§4.2）：终态提交子会话正文——成功/失败/取消均按契约进入同一后端。
   * 先消费引擎压缩捕获（原文+summary 原子 compact——与 Agent 共用核心），再差量
   * checkpoint 余下未提交消息（此前直接全量 checkpoint：压缩后原文丢失、summary
   * 被记成普通 message）。
   */
  const persistChildTranscript = async (): Promise<void> => {
    if (!opts.coordinator) return
    const store = opts.store
    const coordinator = opts.coordinator
    const messages = typeof engine.getMessages === 'function' ? engine.getMessages() : []
    const captures = typeof engine.consumePreCompactCaptures === 'function'
      ? engine.consumePreCompactCaptures()
      : []
    if (messages.length === 0 && captures.length === 0) return
    let state = await store.loadSession(sessionId)
    if (!state) {
      // 未预登记（直接调用未传 ownership）→ 自登记为自身 root
      await coordinator.execute(sessionId, {
        kind: 'register',
        ownership: { rootSessionId: sessionId },
      })
      state = await store.loadSession(sessionId)
    }
    if (!state) return
    // §4.2 compact 编排（与 Agent 共用核心；post = 下一快照 ?? 最终消息）
    for (let idx = 0; idx < captures.length; idx++) {
      const post = captures[idx + 1] ?? messages
      await planAndCommitCompact({ store, coordinator }, sessionId, captures[idx]!, post)
    }
    // 差量 checkpoint：仅提交尚未入库的消息（压缩已入库的原文/summary 不重复）
    if (messages.length === 0) return
    state = await store.loadSession(sessionId)
    if (!state) return
    const branch = state.branches.find((b) => b.branchId === state.currentBranchId)
    const records = branch ? await store.loadRecords(sessionId, branch.records) : []
    const committed = new Set(records.filter((r) => r !== null).map((r) => r!.messageId))
    const newRecords: NewRecord[] = []
    for (const m of messages) {
      const id = (m as { id?: string }).id
      if (id === undefined || committed.has(id)) continue
      committed.add(id)
      newRecords.push({ recordId: crypto.randomUUID(), message: m, actor: { kind: 'sdk' } })
    }
    if (newRecords.length === 0) return
    await coordinator.execute(sessionId, {
      kind: 'checkpoint',
      expectedRevision: state.revision,
      changeSet: {
        kind: 'checkpoint',
        branchId: branch?.branchId ?? (state.currentBranchId || 'b1'),
        newRecords,
        metadataPatch: {},
      },
    })
  }

  // subtask_completed is emitted exactly once for every post-spawn terminal state.
  const finish = async (r: SubagentRun): Promise<SubagentRun> => {
    let outcome = r
    try {
      await persistChildTranscript()
    } catch (err) {
      // R13/R21：正文必须入库——已完成运行的落库失败视为失败（不静默）；失败/取消
      // 并入持久化错误（含 unknown 的 operationId 恢复信息），不丢弃
      const detail = err instanceof Error && err.name === 'CoordinatorUnknownError'
        ? `${String(err)} (recoverable operation: ${(err as { prepared?: { operationId?: string } }).prepared?.operationId ?? 'unknown'})`
        : String(err)
      outcome = {
        ...outcome,
        status: outcome.status === 'completed' ? 'failed' : outcome.status,
        error: outcome.error
          ? `${outcome.error} | transcript persistence failed: ${detail}`
          : `transcript persistence failed: ${detail}`,
      }
    }
    opts.emitEvent?.({
      type: 'subagent',
      parent_tool_use_id: opts.toolUseId,
      session_id: sessionId,
      task_index: opts.taskIndex,
      task_description: opts.description,
      event: {
        type: 'subtask_completed',
        status: outcome.status,
        output: outcome.output,
        error: outcome.error,
        toolsUsed: outcome.toolsUsed,
        maxTurnsHit: outcome.maxTurnsHit,
      },
    })
    return outcome
  }

  const toolCalls = new Set<string>()
  let resultText = ''
  let endSubtype = 'success'
  let maxTurnsHit = false
  let aborted = false
  let eventCount = 0

  try {
    for await (const event of engine.submitMessage(opts.prompt)) {
      eventCount++
      if (opts.abortSignal?.aborted) {
        aborted = true
        break
      }

      if (event.type === 'assistant') {
        for (const block of event.message.content) {
          if (block.type === 'tool_use' && typeof block.name === 'string' && block.name) {
            toolCalls.add(block.name)
          }
          if (block.type === 'text' && block.text) {
            resultText += block.text
          }
        }
      }

      if (event.type === 'result') {
        const subtype = (event as any).subtype || 'success'
        if (subtype === 'error_max_turns') maxTurnsHit = true
        endSubtype = subtype
      }

      if (opts.emitEvent && PROPAGATED_EVENT_TYPES.includes(event.type)) {
        opts.emitEvent({
          type: 'subagent',
          parent_tool_use_id: opts.toolUseId,
          session_id: sessionId,
          task_index: opts.taskIndex,
          task_description: opts.description,
          event: event as any,
        })
      }
    }
  } catch (err: any) {
    return finish({
      status: 'failed',
      output: null,
      error: `Subagent error: ${err.message}`,
      toolsUsed: [...toolCalls],
      sessionId,
      maxTurnsHit: false,
      maxTurns,
    })
  }

  const common = {
    toolsUsed: [...toolCalls],
    sessionId,
    maxTurns,
  }

  const isEngineError = endSubtype.startsWith('error_') && endSubtype !== 'error_max_turns'
  if (isEngineError) {
    return finish({
      ...common,
      status: 'failed',
      output: resultText || null,
      error: `Subagent engine ended with subtype "${endSubtype}".`,
      maxTurnsHit: false,
    })
  }

  if (eventCount === 0) {
    return finish({
      ...common,
      status: 'failed',
      output: null,
      error: 'QueryEngine produced no events. Likely a provider initialization failure, network error, or rate limit.',
      toolsUsed: [],
      maxTurnsHit: false,
    })
  }

  if (!aborted && !maxTurnsHit && !resultText && toolCalls.size === 0) {
    return finish({
      ...common,
      status: 'failed',
      output: null,
      error: 'Subagent completed without producing any text or tool calls. This may indicate a provider error, rate limit, budget exhaustion, or an empty model response.',
      maxTurnsHit: false,
    })
  }

  if (aborted) {
    return finish({
      ...common,
      status: 'aborted',
      output: resultText || null,
      error: 'Subagent aborted by parent signal.',
      maxTurnsHit: false,
    })
  }

  if (maxTurnsHit) {
    return finish({
      ...common,
      status: 'completed',
      output: resultText || `(Subagent hit max turns (${maxTurns}) without producing text output)`,
      error: null,
      maxTurnsHit: true,
    })
  }

  return finish({
    ...common,
    status: 'completed',
    output: resultText || '(Subagent completed with no text output)',
    error: null,
    maxTurnsHit: false,
  })
}

/**
 * Behavior-level integration for subagent todo storage (issue #128 review P2):
 * REAL engine (no vi.mock) so TodoWrite actually executes inside the child,
 * then asserts the child's todos land on the shared storage under the child's
 * sessionId, the parent session stays untouched, and nothing hits the disk.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AgentDefinition, RuntimeEnvironment } from '../types.js'
import type { LLMProvider, StreamChunk, CreateMessageResponse } from '../providers/types.js'
import { InMemorySessionStore } from '../store/in-memory.js'
import { WriteCoordinator } from '../store/coordinator.js'
import { createEmptyServices } from './services.js'
import { runSubagent } from './spawn-subagent.js'

const AGENTS: Record<string, AgentDefinition> = {
  worker: {
    description: 'Worker',
    prompt: 'Do the task.',
    capabilities: { allowedTools: ['TodoWrite'] },
  },
}

function makeRuntime(provider: LLMProvider): RuntimeEnvironment {
  return {
    provider,
    model: 'test-model',
    maxTokens: 4096,
    cwd: '/tmp',
    subprocessEnv: {},
    toolServices: createEmptyServices(),
  }
}

/** Two-pass stream: first call emits a TodoWrite tool_use, second ends the turn. */
function todoProvider(): LLMProvider {
  let pass = 0
  return {
    apiType: 'anthropic-messages',
    async createMessage() {
      throw new Error('not used')
    },
    async *createMessageStream(): AsyncGenerator<StreamChunk> {
      if (pass++ === 0) {
        yield {
          type: 'tool_use',
          index: 1,
          id: 'tu_todo',
          name: 'TodoWrite',
          input: JSON.stringify({ todos: [{ content: 'child task', status: 'pending', priority: 'high' }] }),
        }
        yield { type: 'done', index: -1 }
      } else {
        yield { type: 'text', index: 0, delta: 'child done' }
        yield { type: 'done', index: -1 }
      }
    },
  }
}

describe('subagent todo storage behavior (issue #128 review P2)', () => {
  it('child TodoWrite lands on the shared storage under the child sessionId; parent untouched; no files', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sub-todos-home-'))
    const prevHome = process.env.HOME
    process.env.HOME = home
    try {
      const store = new InMemorySessionStore()
      const coordinator = new WriteCoordinator({ store })
      await coordinator.execute('parent-session', { kind: 'save-todos', todos: [{ content: 'parent task', status: 'pending', priority: 'high' }] })

      const run = await runSubagent({
        runtime: makeRuntime(todoProvider()),
        subAgents: AGENTS,
        agentName: 'worker',
        fallbackAgentId: 'worker',
        mode: 'General',
        prompt: 'do the thing',
        description: 'integration',
        toolUseId: 'tu_outer',
        taskIndex: 0,
        store,
        coordinator,
      })

      expect(run.status).toBe('completed')
      expect(run.sessionId).not.toBe('')
      // R13: child transcript actually persisted (register ≠ transcript)
      const childState = await store.loadSession(run.sessionId)
      expect(childState).not.toBeNull()
      const childBranch = childState!.branches.find((b) => b.branchId === childState!.currentBranchId)
      expect(childBranch?.records.length ?? 0).toBeGreaterThan(0)
      // Behavior: the child's TodoWrite call persisted through the shared store.
      expect(await store.loadTodos(run.sessionId)).toEqual([
        { content: 'child task', status: 'pending', priority: 'high' },
      ])
      // Isolation: the parent session's todos are untouched.
      expect(await store.loadTodos('parent-session')).toEqual([
        { content: 'parent task', status: 'pending', priority: 'high' },
      ])
      // No file backend involvement (restricted HOME stays clean).
      expect(existsSync(join(home, '.agents'))).toBe(false)
    } finally {
      process.env.HOME = prevHome
    }
  })
})

describe('subagent compact persistence (review R21)', () => {
  it('prompt-too-long compaction persists ORIGINAL prompt + summary (kind:summary)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sub-compact-home-'))
    const prevHome = process.env.HOME
    process.env.HOME = home
    try {
      const store = new InMemorySessionStore()
      const coordinator = new WriteCoordinator({ store })
      let streams = 0
      const provider: LLMProvider = {
        apiType: 'anthropic-messages',
        async createMessage(): Promise<CreateMessageResponse> {
          // compactConversation's summary request
          return {
            content: [{ type: 'text', text: 'SUMMARY OF ORIGINAL PROMPT' }],
          } as unknown as CreateMessageResponse
        },
        async *createMessageStream(): AsyncGenerator<StreamChunk> {
          streams++
          if (streams === 1) {
            throw { status: 400, error: { error: { message: 'prompt is too long' } } }
          }
          yield { type: 'text', index: 0, delta: 'child done' }
          yield { type: 'done', index: -1 }
        },
      }
      const run = await runSubagent({
        runtime: makeRuntime(provider),
        subAgents: AGENTS,
        agentName: 'worker',
        fallbackAgentId: 'worker',
        mode: 'General',
        prompt: 'ORIGINAL SUBAGENT PROMPT TEXT',
        description: 'compact integration',
        toolUseId: 'tu_compact',
        taskIndex: 0,
        store,
        coordinator,
      })
      expect(run.status).toBe('completed')
      // §4.2：原文经 compact 原子落库（此前只剩 synthetic pair + 回复，原文永久丢失）
      const state = await store.loadSession(run.sessionId)
      expect(state).not.toBeNull()
      const branch = state!.branches.find((b) => b.branchId === state!.currentBranchId)!
      const records = await store.loadRecords(run.sessionId, branch.records)
      const live = records.filter((r) => r !== null)
      const texts = live.map((r) => JSON.stringify(r.message))
      expect(texts.some((t) => t.includes('ORIGINAL SUBAGENT PROMPT TEXT'))).toBe(true)
      // summary 记录为 kind:'summary'（此前被记成普通 message）
      expect(live.some((r) => r.kind === 'summary')).toBe(true)
      // context 含摘要正文（真实产物 head[0]）
      const ctx = await store.loadContext(run.sessionId, branch.branchId)
      expect(JSON.stringify(ctx)).toContain('SUMMARY OF ORIGINAL PROMPT')
    } finally {
      process.env.HOME = prevHome
    }
  })
})
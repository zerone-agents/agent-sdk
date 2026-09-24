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
import type { LLMProvider, StreamChunk } from '../providers/types.js'
import { InMemorySessionStorage } from '../session-storage-fake.js'
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
      const storage = new InMemorySessionStorage()
      await storage.saveTodos('parent-session', [{ content: 'parent task', status: 'pending', priority: 'high' }])

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
        sessionStorage: storage,
      })

      expect(run.status).toBe('completed')
      expect(run.sessionId).not.toBe('')
      // Behavior: the child's TodoWrite call persisted through the shared storage.
      expect(storage.todosStore.get(run.sessionId)).toEqual([
        { content: 'child task', status: 'pending', priority: 'high' },
      ])
      // Isolation: the parent session's todos are untouched.
      expect(await storage.loadTodos('parent-session')).toEqual([
        { content: 'parent task', status: 'pending', priority: 'high' },
      ])
      // No file backend involvement (restricted HOME stays clean).
      expect(existsSync(join(home, '.agents'))).toBe(false)
    } finally {
      process.env.HOME = prevHome
    }
  })
})
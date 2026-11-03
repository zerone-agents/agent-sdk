/**
 * issue #158: fresh-session mid-query spawn registration.
 *
 * REAL Agent + REAL store (no engine mock — that is exactly why the SDK's own
 * suite never caught this): a stub provider emits a Task tool_use on turn 1,
 * so the spawn's ownership pre-registration runs DURING the engine loop.
 * Before the fix the root session was only self-registered inside
 * persistCheckpoint — after the loop — so prepareChildOwnership's ancestor
 * assertion failed with "ownership target <sid> is not registered".
 */
import { describe, it, expect } from 'vitest'
import { Agent } from './agent.js'
import { InMemorySessionStore } from './store/in-memory.js'
import { WriteCoordinator } from './store/coordinator.js'
import type { LLMProvider, StreamChunk } from './providers/types.js'

/** First provider call (parent turn 1) emits a Task tool_use; later calls (child turn 1, parent turn 2) end with text. */
function spawnProvider(): LLMProvider {
  let call = 0
  return {
    apiType: 'anthropic-messages',
    async createMessage(): Promise<any> { throw new Error('not used') },
    async *createMessageStream(): AsyncGenerator<StreamChunk> {
      call++
      if (call === 1) {
        yield {
          type: 'tool_use',
          index: 0,
          id: 'tu_task',
          name: 'Task',
          // Wire format: the accumulator concatenates argument string
          // fragments, then parses — pass a JSON string, not an object.
          // subagent_type is the MODE; the agent name goes in subagent_name.
          input: JSON.stringify({ description: 'sub work', prompt: 'do the sub work', subagent_type: 'General', subagent_name: 'worker' }),
        }
        yield { type: 'done', index: -1, stopReason: 'tool_use' } as any
      } else {
        yield { type: 'text', index: 0, delta: 'done' }
        yield { type: 'done', index: -1 }
      }
    },
  }
}

describe('fresh-session mid-query spawn registration (issue #158)', () => {
  it('first-query Task spawn succeeds against a real store — root registered before the engine loop', async () => {
    const store = new InMemorySessionStore()
    const agent = new Agent({
      model: 'test-model',
      apiKey: 'test-key',
      apiType: 'anthropic-messages',
      // Streaming mode (e2e fixture convention): without this the engine uses
      // the non-streaming createMessage path, which the stub below rejects.
      includePartialMessages: true,
      store,
      coordinator: new WriteCoordinator({ store }),
      enableFileRevert: false,
      mcpServers: {},
      subAgents: { worker: { description: 'Worker', prompt: 'Work independently.' } },
    } as any)
    // Same injection pattern as agent-resume.e2e.fixture.ts: construct for
    // real, then swap the private provider for the stub.
    ;(agent as any).provider = spawnProvider()

    const events: any[] = []
    for await (const ev of agent.query('do the thing')) events.push(ev)

    const toolResults = events.filter((e) => e.type === 'tool_result')
    expect(toolResults).toHaveLength(1)
    // The spawn must not fail on the ownership assertion.
    expect(toolResults[0].result.is_error).toBe(false)
    expect(String(toolResults[0].result.output)).not.toContain('not registered')
    // subagent events propagate to the parent stream.
    expect(events.some((e) => e.type === 'subagent')).toBe(true)
    // The root session row exists in the store (registered, not just indexed).
    const state = await store.loadSession((agent as any).sid)
    expect(state).not.toBeNull()
  })
})

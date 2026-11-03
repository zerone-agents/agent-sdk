/**
 * issue #158: fresh-session mid-query spawn registration.
 *
 * REAL Agent + REAL store (no engine mock — that is exactly why the SDK's own
 * suite never caught this): a stub provider emits a Task tool_use on turn 1,
 * so the spawn's ownership pre-registration runs DURING the engine loop.
 * Before the fix the root session was only self-registered inside
 * persistCheckpoint — after the loop — so prepareChildOwnership's ancestor
 * assertion failed with "ownership target <sid> is not registered".
 *
 * Review-round additions:
 * - resume path: ownership must track the RESUMED session id (not the
 *   construction-time randomUUID), else spawn-after-resume still fails
 * - blocked/aborted queries must leave no register-only empty row
 * - MultiTask gets its own end-to-end pin; the root registration must be the
 *   FIRST register commit (before any child pre-registration)
 */
import { describe, it, expect } from 'vitest'
import { Agent } from './agent.js'
import { InMemorySessionStore } from './store/in-memory.js'
import { WriteCoordinator } from './store/coordinator.js'
import type { AgentOptions } from './types.js'
import type { LLMProvider, StreamChunk } from './providers/types.js'

/** Private-field access seam — same pattern as ownership.test.ts / agent.v4.test.ts. */
interface AgentInternals {
  provider: LLMProvider
  sid: string
}
const internals = (a: Agent): AgentInternals => a as unknown as AgentInternals

/** Records every coordinator commit in order (registration-order pin). */
class RecordingCoordinator extends WriteCoordinator {
  ops: Array<{ sid: string; kind: string }> = []
  override async execute(sid: string, op: { kind: string }): Promise<any> {
    this.ops.push({ sid, kind: op.kind })
    return super.execute(sid, op as any)
  }
}

function baseOptions(store: InMemorySessionStore, coordinator: WriteCoordinator): AgentOptions {
  return {
    model: 'test-model',
    apiKey: 'test-key',
    apiType: 'anthropic-messages',
    // Streaming mode: without this the engine uses the non-streaming
    // createMessage path, which the stubs below reject.
    includePartialMessages: true,
    store,
    coordinator,
    enableFileRevert: false,
    mcpServers: {},
    subAgents: { worker: { description: 'Worker', prompt: 'Work independently.' } },
  }
}

/**
 * First provider call (parent turn 1) emits a Task/MultiTask tool_use; later
 * calls (child turn 1, parent turn 2) end with text.
 *
 * Wire-format notes: the accumulator concatenates argument STRING fragments
 * then parses — pass a JSON string, not an object. subagent_type is the MODE;
 * the agent name goes in subagent_name.
 */
function spawnProvider(tool: 'Task' | 'MultiTask'): LLMProvider {
  const input = tool === 'Task'
    ? { description: 'sub work', prompt: 'do the sub work', subagent_type: 'General', subagent_name: 'worker' }
    : { tasks: [{ description: 'sub work', prompt: 'do the sub work', subagent_type: 'General', subagent_name: 'worker' }] }
  let call = 0
  return {
    apiType: 'anthropic-messages',
    async createMessage(): Promise<any> { throw new Error('not used') },
    async *createMessageStream(): AsyncGenerator<StreamChunk> {
      call++
      if (call === 1) {
        yield { type: 'tool_use', index: 0, id: 'tu_task', name: tool, input: JSON.stringify(input) }
        yield { type: 'done', index: -1 }
      } else {
        yield { type: 'text', index: 0, delta: 'done' }
        yield { type: 'done', index: -1 }
      }
    },
  }
}

/** Never emits tools — for the session-seeding phase of the resume test. */
function textProvider(): LLMProvider {
  return {
    apiType: 'anthropic-messages',
    async createMessage(): Promise<any> { throw new Error('not used') },
    async *createMessageStream(): AsyncGenerator<StreamChunk> {
      yield { type: 'text', index: 0, delta: 'seeded' }
      yield { type: 'done', index: -1 }
    },
  }
}

async function drain(agent: Agent, prompt: string): Promise<any[]> {
  const events: any[] = []
  for await (const ev of agent.query(prompt)) events.push(ev)
  return events
}

function assertSpawnSucceeded(events: any[]): void {
  const toolResults = events.filter((e) => e.type === 'tool_result')
  expect(toolResults).toHaveLength(1)
  expect(toolResults[0].result.is_error).toBe(false)
  expect(String(toolResults[0].result.output)).not.toContain('not registered')
  expect(events.some((e) => e.type === 'subagent')).toBe(true)
}

describe('fresh-session mid-query spawn registration (issue #158)', () => {
  it('first-query Task spawn succeeds against a real store — root registered before the engine loop', async () => {
    const store = new InMemorySessionStore()
    const coordinator = new RecordingCoordinator({ store })
    const agent = new Agent(baseOptions(store, coordinator))
    internals(agent).provider = spawnProvider('Task')

    const events = await drain(agent, 'do the thing')

    assertSpawnSucceeded(events)
    // The root registration must be the FIRST register commit — before the
    // parent-row and child pre-registrations that the spawn performs.
    const registers = coordinator.ops.filter((o) => o.kind === 'register')
    expect(registers[0].sid).toBe(internals(agent).sid)
  })

  it('first-query MultiTask spawn succeeds the same way (review: independent pin)', async () => {
    const store = new InMemorySessionStore()
    const coordinator = new RecordingCoordinator({ store })
    const agent = new Agent(baseOptions(store, coordinator))
    internals(agent).provider = spawnProvider('MultiTask')

    assertSpawnSucceeded(await drain(agent, 'do the thing'))
  })
})

describe('resume + spawn ownership (issue #158 review)', () => {
  it('resume recomputes ownership to the resumed session id — mid-query spawn still works', async () => {
    const store = new InMemorySessionStore()
    const coordinator = new WriteCoordinator({ store })

    // Phase 1: seed the session with a plain agent.
    const creator = new Agent(baseOptions(store, coordinator))
    internals(creator).provider = textProvider()
    await drain(creator, 'seed')
    const sid = internals(creator).sid

    // Phase 2: resume into a NEW agent (fresh construction-time sid) whose
    // provider spawns on turn 1.
    const resumed = new Agent({ ...baseOptions(store, coordinator), resume: sid })
    internals(resumed).provider = spawnProvider('Task')

    assertSpawnSucceeded(await drain(resumed, 'spawn now'))
  })
})

describe('blocked queries leave no register-only row (issue #158 review)', () => {
  it('UserPromptSubmit-blocked query creates no session row', async () => {
    const store = new InMemorySessionStore()
    const coordinator = new WriteCoordinator({ store })
    const agent = new Agent({
      ...baseOptions(store, coordinator),
      hooks: { UserPromptSubmit: [{ hooks: [async () => ({ block: true })] }] },
    })
    internals(agent).provider = spawnProvider('Task')

    const events = await drain(agent, 'blocked')

    // Blocked: error result, no tool execution.
    expect(events.some((e) => e.type === 'tool_result')).toBe(false)
    // No register-only empty row — the old persistCheckpoint invariant.
    expect(await store.loadSession(internals(agent).sid)).toBeNull()
  })
})

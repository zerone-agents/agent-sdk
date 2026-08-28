import { describe, it, expect } from 'vitest'
import { Agent } from './agent.js'
import { loadSession, deleteSession } from './session.js'
import type {
  LLMProvider,
  CreateMessageParams,
  CreateMessageResponse,
} from './providers/types.js'

/**
 * Minimal LLMProvider that returns a single static text response without
 * making any network calls. Pattern borrowed from
 * src/utils/session-turns-integration.test.ts:24 (RecordingProvider).
 */
class FakeProvider implements LLMProvider {
  readonly apiType = 'anthropic-messages' as const

  async createMessage(
    _params: CreateMessageParams,
  ): Promise<CreateMessageResponse> {
    return {
      content: [{ type: 'text', text: 'mock response' }],
      stopReason: 'end_turn',
      usage: {
        input_tokens: 5,
        output_tokens: 3,
        totalInputTokens: 5,
      },
    }
  }
}

/**
 * Build an Agent with persistSession disabled (no disk writes) and
 * permissionMode bypassed. Monkey-patches the private `provider` field
 * so `prompt()` uses FakeProvider instead of hitting a real LLM.
 */
function makeAgent(): Agent {
  const agent = new Agent({
    apiKey: 'fake-key',
    persistSession: false,
    permissionMode: 'bypassPermissions',
    // Disable SnapshotEngine: these tests run concurrently and would all
    // `git init --bare` into the same shared ~/.agents/snapshot/<hash> dir,
    // racing on git's config lock. Not under test here.
    enableFileRevert: false,
  })
  ;(agent as any).provider = new FakeProvider()
  return agent
}

describe('Agent message log', () => {
  it('exposes getMessageLog() returning the audit log array', async () => {
    const agent = makeAgent()
    await agent.prompt('hi')

    expect(typeof agent.getMessageLog).toBe('function')
    const log = agent.getMessageLog()
    expect(Array.isArray(log)).toBe(true)
    expect(log.length).toBeGreaterThan(0)
  })

  it('emits user message BEFORE assistant response (chronological order)', async () => {
    const agent = makeAgent()
    await agent.prompt('hi')

    const log = agent.getMessageLog()
    const roles = log.map((m) => m.type)
    const userIdx = roles.indexOf('user')
    const assistantIdx = roles.indexOf('assistant')

    expect(userIdx).toBeGreaterThanOrEqual(0)
    expect(assistantIdx).toBeGreaterThanOrEqual(0)
    // Order regression: user prompt must precede its assistant response.
    expect(userIdx).toBeLessThan(assistantIdx)
  })

  it('does not expose legacy getMessages() (no silent alias)', () => {
    const agent = makeAgent()
    expect((agent as any).getMessages).toBeUndefined()
  })
})

describe('Agent message log timestamps (issue #54)', () => {
  it('messageLog entries reuse engine history id and timestamp', async () => {
    const agent = makeAgent()
    await agent.prompt('hi')

    const log = agent.getMessageLog()
    expect(log).toHaveLength(2)
    const [userEntry, assistantEntry] = log

    const history = await agent.getMessageHistory()
    const userMsg = history.find((m) => m.role === 'user')!
    const assistantMsg = history.find((m) => m.role === 'assistant')!

    expect(userEntry.type).toBe('user')
    expect(userEntry.uuid).toBe(userMsg.id)
    expect(userEntry.timestamp).toBe(userMsg.timestamp)
    expect(Date.parse(userEntry.timestamp)).not.toBeNaN()

    expect(assistantEntry.type).toBe('assistant')
    expect(assistantEntry.uuid).toBe(assistantMsg.id)
    expect(assistantEntry.timestamp).toBe(assistantMsg.timestamp)
    expect(Date.parse(assistantEntry.timestamp)).not.toBeNaN()
  })

  it('hook-blocked prompt enters neither history nor messageLog', async () => {
    const agent = new Agent({
      apiKey: 'fake-key',
      persistSession: false,
      permissionMode: 'bypassPermissions',
      enableFileRevert: false,
      hooks: {
        UserPromptSubmit: [{ hooks: [async () => ({ block: true })] }],
      },
    })
    ;(agent as any).provider = new FakeProvider()

    const result = await agent.prompt('hi')
    expect(result.is_error).toBe(true)
    expect(result.errors?.join(' ')).toContain('Blocked by UserPromptSubmit hook')

    expect(agent.getMessageLog()).toHaveLength(0)
    expect(await agent.getMessageHistory()).toHaveLength(0)
  })

  it('persistSession round-trip keeps timestamps on disk', async () => {
    const agent = new Agent({
      apiKey: 'fake-key',
      persistSession: true,
      permissionMode: 'bypassPermissions',
      enableFileRevert: false,
    })
    ;(agent as any).provider = new FakeProvider()
    const sid = (agent as any).sid as string
    try {
      await agent.prompt('hi')
      const data = await loadSession(sid)
      const msgs = data!.messages
      expect(msgs.length).toBeGreaterThanOrEqual(2)
      for (const m of msgs) {
        expect(Date.parse(m.timestamp ?? '')).not.toBeNaN()
      }
      // Disk timestamps equal what the in-process log saw.
      const log = agent.getMessageLog()
      const userMsg = msgs.find((m) => m.role === 'user')!
      expect(userMsg.id).toBe(log[0].uuid)
      expect(userMsg.timestamp).toBe(log[0].timestamp)
    } finally {
      await deleteSession(sid)
    }
  })
})

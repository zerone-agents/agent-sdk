/**
 * Multi-Agent Isolation Tests
 *
 * Verifies that two Agent instances, each with their own ToolServices,
 * have fully isolated state: teams, plan mode, config, messaging, tool
 * search registry, and askUser handler do not leak between agents.
 *
 * These tests exercise the real tool `call()` methods through ToolContext
 * to prove end-to-end isolation from the tool layer down to the service
 * storage.
 */

import { describe, it, expect } from 'vitest'
import { DefaultToolServices } from './default-services.js'
import { TeamCreateTool, TeamDeleteTool } from './team.js'
import { EnterPlanModeTool, ExitPlanModeTool } from './plan.js'
import { ConfigTool } from './config.js'
import { SendMessageTool } from './send-message.js'
import { ToolSearchTool } from './tool-search.js'
import type { ToolContext } from '../types.js'

/**
 * Build a minimal ToolContext bound to the given services.
 *
 * Mirrors what `engine/tool-executor.ts` constructs for each tool call.
 */
function makeCtx(
  services: DefaultToolServices,
  agentId: string,
): ToolContext {
  return {
    cwd: process.cwd(),
    agentId,
    services,
  }
}

describe('Multi-agent isolation with ToolServices', () => {
  describe('team storage', () => {
    it('two agents have independent team storage', async () => {
      const svcA = new DefaultToolServices()
      const svcB = new DefaultToolServices()
      const ctxA = makeCtx(svcA, 'agent-a')
      const ctxB = makeCtx(svcB, 'agent-b')

      // Agent A creates two teams
      const r1 = await TeamCreateTool.call(
        { name: 'Alpha Team', members: ['a1', 'a2'] },
        ctxA,
      )
      const r2 = await TeamCreateTool.call(
        { name: 'Beta Team', members: ['a3'] },
        ctxA,
      )
      expect(r1.content).toContain('Alpha Team')
      expect(r2.content).toContain('Beta Team')

      // Agent B creates one team
      const r3 = await TeamCreateTool.call(
        { name: 'Solo Team', members: ['b1'] },
        ctxB,
      )
      expect(r3.content).toContain('Solo Team')

      // Agent A has 2 teams with counter=2
      expect(svcA.team.teams.size).toBe(2)
      expect(svcA.team.counter).toBe(2)
      expect(svcA.team.teams.get('team_1')?.name).toBe('Alpha Team')
      expect(svcA.team.teams.get('team_2')?.name).toBe('Beta Team')

      // Agent B has 1 team with counter=1 (no shared counter state)
      expect(svcB.team.teams.size).toBe(1)
      expect(svcB.team.counter).toBe(1)
      expect(svcB.team.teams.get('team_1')?.name).toBe('Solo Team')

      // Deleting on Agent A does not affect Agent B
      await TeamDeleteTool.call({ id: 'team_1' }, ctxA)
      expect(svcA.team.teams.size).toBe(1)
      expect(svcB.team.teams.size).toBe(1)
    })
  })

  describe('plan state', () => {
    it('two agents have independent plan state', async () => {
      const svcA = new DefaultToolServices()
      const svcB = new DefaultToolServices()
      const ctxA = makeCtx(svcA, 'agent-a')
      const ctxB = makeCtx(svcB, 'agent-b')

      // Agent A enters plan mode
      const enter = await EnterPlanModeTool.call({}, ctxA)
      expect(enter.content).toContain('Entered plan mode')
      expect(svcA.plan.active).toBe(true)

      // Agent B is still not in plan mode
      expect(svcB.plan.active).toBe(false)
      expect(svcB.plan.currentPlan).toBeNull()

      // Agent A exits plan mode with a plan
      const exit = await ExitPlanModeTool.call(
        { plan: 'Do the thing', approved: true },
        ctxA,
      )
      expect(exit.content).toContain('approved')
      expect(svcA.plan.active).toBe(false)
      expect(svcA.plan.currentPlan).toBe('Do the thing')

      // Agent B still unaffected
      expect(svcB.plan.active).toBe(false)

      // Agent B can enter its own plan mode independently
      await EnterPlanModeTool.call({}, ctxB)
      expect(svcB.plan.active).toBe(true)
      expect(svcA.plan.active).toBe(false)
    })

    it('entering plan mode twice on one agent does not affect the other', async () => {
      const svcA = new DefaultToolServices()
      const svcB = new DefaultToolServices()

      await EnterPlanModeTool.call({}, makeCtx(svcA, 'agent-a'))
      // Second enter on A returns "already in plan mode"
      const again = await EnterPlanModeTool.call({}, makeCtx(svcA, 'agent-a'))
      expect(again.content).toContain('Already in plan mode')

      // B can still enter cleanly
      const firstForB = await EnterPlanModeTool.call({}, makeCtx(svcB, 'agent-b'))
      expect(firstForB.content).toContain('Entered plan mode')
    })
  })

  describe('config state', () => {
    it('two agents have independent config state', async () => {
      const svcA = new DefaultToolServices()
      const svcB = new DefaultToolServices()
      const ctxA = makeCtx(svcA, 'agent-a')
      const ctxB = makeCtx(svcB, 'agent-b')

      // Agent A sets config values
      await ConfigTool.call(
        { action: 'set', key: 'api_key', value: 'secret-A' },
        ctxA,
      )
      await ConfigTool.call(
        { action: 'set', key: 'timeout', value: 3000 },
        ctxA,
      )

      // Agent A sees its own values
      const getA = await ConfigTool.call(
        { action: 'get', key: 'api_key' },
        ctxA,
      )
      expect(getA.content).toBe(JSON.stringify('secret-A'))

      // Agent B cannot see Agent A's values
      const getB = await ConfigTool.call(
        { action: 'get', key: 'api_key' },
        ctxB,
      )
      expect(getB.content).toContain('not found')

      // Agent B sets its own config
      await ConfigTool.call(
        { action: 'set', key: 'api_key', value: 'secret-B' },
        ctxB,
      )

      // Each agent reads its own value
      expect(
        (await ConfigTool.call({ action: 'get', key: 'api_key' }, ctxA)).content,
      ).toBe(JSON.stringify('secret-A'))
      expect(
        (await ConfigTool.call({ action: 'get', key: 'api_key' }, ctxB)).content,
      ).toBe(JSON.stringify('secret-B'))

      // Listing on each agent shows only that agent's entries
      const listA = await ConfigTool.call({ action: 'list' }, ctxA)
      const listB = await ConfigTool.call({ action: 'list' }, ctxB)
      expect(listA.content).toContain('api_key')
      expect(listA.content).toContain('timeout')
      expect(listA.content).not.toContain('secret-B')
      expect(listB.content).toContain('api_key')
      expect(listB.content).not.toContain('timeout')
      expect(listB.content).not.toContain('secret-A')
    })
  })

  describe('message mailboxes', () => {
    it('two agents have independent message mailboxes', async () => {
      const svcA = new DefaultToolServices()
      const svcB = new DefaultToolServices()
      const ctxA = makeCtx(svcA, 'agent-a')
      const ctxB = makeCtx(svcB, 'agent-b')

      // Agent A sends a message to "alice"
      await SendMessageTool.call(
        { to: 'alice', content: 'Hello from A' },
        ctxA,
      )

      // Agent B sends a message to "bob"
      await SendMessageTool.call(
        { to: 'bob', content: 'Hello from B' },
        ctxB,
      )

      // Agent A's mailbox for alice has the message; bob is unknown
      const aliceMsgs = svcA.messaging.read('alice')
      expect(aliceMsgs).toHaveLength(1)
      expect(aliceMsgs[0].content).toBe('Hello from A')
      expect(svcA.messaging.read('bob')).toHaveLength(0)

      // Agent B's mailbox for bob has the message; alice is unknown
      const bobMsgs = svcB.messaging.read('bob')
      expect(bobMsgs).toHaveLength(1)
      expect(bobMsgs[0].content).toBe('Hello from B')
      expect(svcB.messaging.read('alice')).toHaveLength(0)
    })

    it('broadcast on one agent does not affect the other', async () => {
      const svcA = new DefaultToolServices()
      const svcB = new DefaultToolServices()

      // Seed mailboxes on Agent A (broadcast only iterates existing keys)
      svcA.messaging.send('alice', {
        from: 'system',
        to: 'alice',
        content: 'seed',
        timestamp: new Date().toISOString(),
        type: 'text',
      })
      svcA.messaging.send('bob', {
        from: 'system',
        to: 'bob',
        content: 'seed',
        timestamp: new Date().toISOString(),
        type: 'text',
      })

      // Agent A broadcasts
      await SendMessageTool.call(
        { to: '*', content: 'Broadcast from A' },
        makeCtx(svcA, 'agent-a'),
      )

      // Agent A: alice and bob got the broadcast
      expect(svcA.messaging.read('alice')).toHaveLength(2)
      expect(svcA.messaging.read('bob')).toHaveLength(2)

      // Agent B: completely empty
      expect(svcB.messaging.read('alice')).toHaveLength(0)
      expect(svcB.messaging.read('bob')).toHaveLength(0)
    })

    it('clear on one agent does not affect the other', async () => {
      const svcA = new DefaultToolServices()
      const svcB = new DefaultToolServices()

      svcA.messaging.send('x', {
        from: 'a',
        to: 'x',
        content: 'msgA',
        timestamp: new Date().toISOString(),
        type: 'text',
      })
      svcB.messaging.send('x', {
        from: 'b',
        to: 'x',
        content: 'msgB',
        timestamp: new Date().toISOString(),
        type: 'text',
      })

      svcA.messaging.clear()

      expect(svcA.messaging.read('x')).toHaveLength(0)
      const bMessages = svcB.messaging.read('x')
      expect(bMessages).toHaveLength(1)
      expect(bMessages[0].content).toBe('msgB')
    })
  })

  describe('tool search registry', () => {
    it('two agents have independent deferred tool registries', () => {
      const svcA = new DefaultToolServices()
      const svcB = new DefaultToolServices()

      const mockToolA = {
        name: 'ToolA',
        description: 'Only in A',
        inputSchema: { type: 'object' as const, properties: {} },
        isReadOnly: () => true,
        isConcurrencySafe: () => true,
        isEnabled: () => true,
        prompt: async () => '',
        call: async () => ({ type: 'tool_result' as const, tool_use_id: '', content: 'a' }),
      }
      const mockToolB = {
        name: 'ToolB',
        description: 'Only in B',
        inputSchema: { type: 'object' as const, properties: {} },
        isReadOnly: () => true,
        isConcurrencySafe: () => true,
        isEnabled: () => true,
        prompt: async () => '',
        call: async () => ({ type: 'tool_result' as const, tool_use_id: '', content: 'b' }),
      }

      svcA.toolSearch.deferredTools.push(mockToolA)
      svcB.toolSearch.deferredTools.push(mockToolB)

      expect(svcA.toolSearch.deferredTools).toHaveLength(1)
      expect(svcA.toolSearch.deferredTools[0].name).toBe('ToolA')
      expect(svcB.toolSearch.deferredTools).toHaveLength(1)
      expect(svcB.toolSearch.deferredTools[0].name).toBe('ToolB')
    })
  })

  describe('askUser handler', () => {
    it('two agents have independent askUser handlers', async () => {
      const svcA = new DefaultToolServices()
      const svcB = new DefaultToolServices()

      // Both start null
      expect(svcA.askUser).toBeNull()
      expect(svcB.askUser).toBeNull()

      // Agent A wires up a handler
      svcA.askUser = async (q: string) => `A answered: ${q}`

      // Agent B still has no handler
      expect(svcB.askUser).toBeNull()

      // Calling A's handler works
      expect(await svcA.askUser('hello?', ['y', 'n'])).toBe('A answered: hello?')

      // Replace A's handler; B still unaffected
      svcA.askUser = async () => 'replaced'
      expect(await svcA.askUser('', [])).toBe('replaced')
      expect(svcB.askUser).toBeNull()
    })
  })

  describe('concurrent realistic scenario', () => {
    it('two agents running full workflows do not interfere', async () => {
      const svcA = new DefaultToolServices()
      const svcB = new DefaultToolServices()
      const ctxA = makeCtx(svcA, 'planner-agent')
      const ctxB = makeCtx(svcB, 'worker-agent')

      // --- Agent A: planner workflow ---
      // 1. Set some config
      await ConfigTool.call(
        { action: 'set', key: 'role', value: 'planner' },
        ctxA,
      )
      // 2. Enter plan mode
      await EnterPlanModeTool.call({}, ctxA)
      // 3. Create a team
      await TeamCreateTool.call(
        { name: 'Plan Reviewers', members: ['reviewer-1'] },
        ctxA,
      )
      // 4. Send a message
      await SendMessageTool.call(
        { to: 'reviewer-1', content: 'Please review my plan' },
        ctxA,
      )

      // --- Agent B: worker workflow ---
      // 1. Set different config
      await ConfigTool.call(
        { action: 'set', key: 'role', value: 'worker' },
        ctxB,
      )
      await ConfigTool.call(
        { action: 'set', key: 'max_tasks', value: 5 },
        ctxB,
      )
      // 2. Worker does NOT enter plan mode
      // 3. Create its own team
      await TeamCreateTool.call(
        { name: 'Executors', members: ['exec-1', 'exec-2', 'exec-3'] },
        ctxB,
      )
      // 4. Send messages to its own teammates
      await SendMessageTool.call(
        { to: 'exec-1', content: 'Start task 1' },
        ctxB,
      )
      await SendMessageTool.call(
        { to: 'exec-2', content: 'Start task 2' },
        ctxB,
      )

      // --- Verify isolation ---

      // Teams
      expect(svcA.team.teams.size).toBe(1)
      expect(svcA.team.teams.get('team_1')?.name).toBe('Plan Reviewers')
      expect(svcB.team.teams.size).toBe(1)
      expect(svcB.team.teams.get('team_1')?.name).toBe('Executors')
      expect(svcB.team.teams.get('team_1')?.members).toHaveLength(3)

      // Plan state
      expect(svcA.plan.active).toBe(true)
      expect(svcB.plan.active).toBe(false)

      // Config
      expect(svcA.config.get('role')).toBe('planner')
      expect(svcA.config.size).toBe(1)
      expect(svcB.config.get('role')).toBe('worker')
      expect(svcB.config.get('max_tasks')).toBe(5)
      expect(svcB.config.size).toBe(2)

      // Messages
      expect(svcA.messaging.read('reviewer-1')).toHaveLength(1)
      expect(svcA.messaging.read('exec-1')).toHaveLength(0)
      expect(svcB.messaging.read('exec-1')).toHaveLength(1)
      expect(svcB.messaging.read('exec-2')).toHaveLength(1)
      expect(svcB.messaging.read('reviewer-1')).toHaveLength(0)
    })
  })
})

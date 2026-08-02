/**
 * Tests for DefaultToolServices — verifies per-instance state isolation
 */

import { describe, it, expect } from 'vitest'
import { DefaultToolServices } from './default-services.js'

describe('DefaultToolServices', () => {
  describe('instance isolation', () => {
    it('creates separate team storage per instance', () => {
      const services1 = new DefaultToolServices()
      const services2 = new DefaultToolServices()

      // Modify instance 1
      services1.team.teams.set('team_1', {
        id: 'team_1',
        name: 'Team 1',
        members: ['agent-a'],
        leaderId: 'agent-a',
        createdAt: new Date().toISOString(),
        status: 'active',
      })
      services1.team.counter = 5

      // Instance 2 should be unaffected
      expect(services2.team.teams.size).toBe(0)
      expect(services2.team.counter).toBe(0)
    })

    it('creates separate messaging per instance', () => {
      const services1 = new DefaultToolServices()
      const services2 = new DefaultToolServices()

      // Send message via instance 1
      services1.messaging.send('agent-a', {
        from: 'agent-b',
        to: 'agent-a',
        content: 'Hello from instance 1',
        timestamp: new Date().toISOString(),
        type: 'text',
      })

      // Instance 1 should have the message
      const messages1 = services1.messaging.read('agent-a')
      expect(messages1).toHaveLength(1)
      expect(messages1[0].content).toBe('Hello from instance 1')

      // Instance 2 should have no messages for agent-a
      const messages2 = services2.messaging.read('agent-a')
      expect(messages2).toHaveLength(0)
    })

    it('creates separate messaging broadcast per instance', () => {
      const services1 = new DefaultToolServices()
      const services2 = new DefaultToolServices()

      // Pre-populate mailboxes in instance 1
      services1.messaging.send('agent-a', {
        from: 'system',
        to: 'agent-a',
        content: 'init',
        timestamp: new Date().toISOString(),
        type: 'text',
      })

      // Broadcast on instance 1
      services1.messaging.broadcast({
        from: 'leader',
        to: '',
        content: 'broadcast msg',
        timestamp: new Date().toISOString(),
        type: 'text',
      })

      // Instance 1: agent-a should have init + broadcast
      const msg1 = services1.messaging.read('agent-a')
      expect(msg1).toHaveLength(2)
      expect(msg1[1].content).toBe('broadcast msg')
      expect(msg1[1].to).toBe('agent-a')

      // Instance 2 should have no mailboxes at all
      const msg2 = services2.messaging.read('agent-a')
      expect(msg2).toHaveLength(0)
    })

    it('creates separate messaging clear per instance', () => {
      const services1 = new DefaultToolServices()
      const services2 = new DefaultToolServices()

      services1.messaging.send('agent-a', {
        from: 'agent-b',
        to: 'agent-a',
        content: 'msg',
        timestamp: new Date().toISOString(),
        type: 'text',
      })

      // Clear instance 1
      services1.messaging.clear()
      expect(services1.messaging.read('agent-a')).toHaveLength(0)

      // Instance 2 should be unaffected (already empty, but verify isolation)
      expect(services2.messaging.read('agent-a')).toHaveLength(0)
    })

    it('creates separate askUser handler per instance', () => {
      const services1 = new DefaultToolServices()
      const services2 = new DefaultToolServices()

      // Both start null
      expect(services1.askUser).toBeNull()
      expect(services2.askUser).toBeNull()

      // Set handler on instance 1
      services1.askUser = async (question: string) => `answer to: ${question}`

      // Instance 2 should still be null
      expect(services2.askUser).toBeNull()
    })

    it('creates separate tool search registry per instance', () => {
      const services1 = new DefaultToolServices()
      const services2 = new DefaultToolServices()

      const mockTool = {
        name: 'MockTool',
        description: 'A mock tool',
        inputSchema: { type: 'object' as const, properties: {} },
        isReadOnly: () => true,
        isConcurrencySafe: () => true,
        isEnabled: () => true,
        prompt: async () => 'mock',
        call: async () => ({ type: 'tool_result' as const, tool_use_id: '', content: 'result' }),
      }

      // Add to instance 1
      services1.toolSearch.deferredTools.push(mockTool)
      expect(services1.toolSearch.deferredTools).toHaveLength(1)

      // Instance 2 should be unaffected
      expect(services2.toolSearch.deferredTools).toHaveLength(0)
    })

    it('creates separate plan state per instance', () => {
      const services1 = new DefaultToolServices()
      const services2 = new DefaultToolServices()

      // Both start inactive
      expect(services1.plan.active).toBe(false)
      expect(services2.plan.active).toBe(false)

      // Activate plan on instance 1
      services1.plan.active = true
      services1.plan.currentPlan = 'Do something'

      // Instance 2 should be unaffected
      expect(services2.plan.active).toBe(false)
      expect(services2.plan.currentPlan).toBeNull()
    })

    it('creates separate config storage per instance', () => {
      const services1 = new DefaultToolServices()
      const services2 = new DefaultToolServices()

      // Set config on instance 1
      services1.config.set('api_key', 'secret-123')
      services1.config.set('timeout', 30000)

      expect(services1.config.size).toBe(2)
      expect(services1.config.get('api_key')).toBe('secret-123')

      // Instance 2 should be empty
      expect(services2.config.size).toBe(0)
      expect(services2.config.get('api_key')).toBeUndefined()
    })
  })

  describe('initial state', () => {
    it('initializes with correct default values', () => {
      const services = new DefaultToolServices()

      expect(services.team.teams.size).toBe(0)
      expect(services.team.counter).toBe(0)
      expect(services.askUser).toBeNull()
      expect(services.toolSearch.deferredTools).toHaveLength(0)
      expect(services.plan.active).toBe(false)
      expect(services.plan.currentPlan).toBeNull()
      expect(services.config.size).toBe(0)
    })

    it('messaging read returns empty for unknown agent', () => {
      const services = new DefaultToolServices()
      expect(services.messaging.read('unknown-agent')).toHaveLength(0)
    })
  })
})

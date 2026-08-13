/**
 * Tests for DefaultToolServices — verifies per-instance state isolation
 */

import { describe, it, expect } from 'vitest'
import { DefaultToolServices } from './default-services.js'

describe('DefaultToolServices', () => {
  describe('instance isolation', () => {
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
      services1.findTool.deferredTools.push(mockTool)
      expect(services1.findTool.deferredTools).toHaveLength(1)

      // Instance 2 should be unaffected
      expect(services2.findTool.deferredTools).toHaveLength(0)
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

      expect(services.askUser).toBeNull()
      expect(services.findTool.deferredTools).toHaveLength(0)
      expect(services.config.size).toBe(0)
    })
  })
})

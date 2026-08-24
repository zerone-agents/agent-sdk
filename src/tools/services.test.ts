/**
 * Tests for resolveToolServices — per-Agent ToolServices combinator (ADR 0005).
 */

import { describe, it, expect } from 'vitest'
import type { CronService } from '../cron/service.js'
import { createEmptyServices, resolveToolServices } from './services.js'

describe('resolveToolServices', () => {
  it('does not mutate a caller-shared ToolServices when overriding cron', () => {
    const shared = createEmptyServices()
    const cronA = {} as CronService
    const cronB = {} as CronService
    const a = resolveToolServices(shared, cronA)
    const b = resolveToolServices(shared, cronB)
    // The caller's object is never mutated
    expect(shared.cron).toBeNull()
    // Two Agents sharing one container get independent cron bindings
    expect(a.cron).toBe(cronA)
    expect(b.cron).toBe(cronB)
    expect(a.cron).not.toBe(b.cron)
    // The copies are not the caller's object
    expect(a).not.toBe(shared)
    expect(b).not.toBe(shared)
    // Non-overridden services are shared by reference (caller-controlled sharing)
    expect(a.findTool).toBe(shared.findTool)
    expect(a.config).toBe(shared.config)
  })

  it('uses the caller object as-is without an override', () => {
    const shared = createEmptyServices()
    expect(resolveToolServices(shared, undefined)).toBe(shared)
    expect(resolveToolServices(shared, null)).toBe(shared)
    expect(resolveToolServices(undefined, undefined).cron).toBeNull()
  })

  it('creates a fresh DefaultToolServices with cron when no caller object is given', () => {
    const cron = {} as CronService
    const services = resolveToolServices(undefined, cron)
    expect(services.cron).toBe(cron)
    expect(services.askUser).toBeNull()
    expect(services.findTool.deferredTools).toEqual([])
    expect(services.findTool.activatedTools).toBeInstanceOf(Set)
    expect(services.config).toBeInstanceOf(Map)
  })

  it('preserves other caller-provided services when overriding cron', () => {
    const shared = createEmptyServices()
    const handler = async () => 'answer'
    shared.askUser = handler
    shared.webSearch = { apiKey: 'exa-key' }
    const cron = {} as CronService
    const combined = resolveToolServices(shared, cron)
    expect(combined.askUser).toBe(handler)
    expect(combined.webSearch).toEqual({ apiKey: 'exa-key' })
    // Original keeps its own (unset) cron
    expect(shared.cron).toBeNull()
  })
})

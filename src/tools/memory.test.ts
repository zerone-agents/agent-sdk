/**
 * Tool-level tests for the built-in Memory / MemorySearch tools (issue #61).
 *
 * Every test creates a REAL MemoryService; the afterEach fixture guarantees
 * `stop()` even when an assertion fails mid-test — a leaked `start()` keeps
 * the storage open and can break later tests (issue #61-era lesson).
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryService } from '../memory/service.js'
import { InMemoryMemoryStorage } from '../memory/in-memory-storage.js'
import { defaultMemoryWorkspaceResolver } from '../memory/workspace.js'
import type { MemoryService } from '../memory/types.js'
import { MemorySearchTool, MemoryTool } from './memory.js'
import { MEMORY_SEARCH_DEFAULT_LIMIT, MEMORY_SEARCH_MAX_LIMIT } from '../memory/search.js'
import type { ToolContext } from '../types.js'

const liveServices: MemoryService[] = []

async function makeContext(): Promise<{ ctx: ToolContext; stop: () => Promise<void> }> {
  const service = createMemoryService({ storage: new InMemoryMemoryStorage() })
  liveServices.push(service)
  await service.start()
  const ctx: ToolContext = {
    cwd: '/repo/a',
    agentId: 'main',
    sessionId: 's1',
    services: { memory: service } as unknown as ToolContext['services'],
    subprocessEnv: {},
    abortSignal: undefined,
    toolUseId: 'tu1',
  }
  return { ctx, stop: () => service.stop() }
}

afterEach(async () => {
  await Promise.all(liveServices.splice(0).map((s) => s.stop()))
})

describe('Memory tool (tool-level)', () => {
  it('is deferred, mutating, and non-concurrency-safe by contract', () => {
    expect(MemoryTool.deferred).toBe(true)
    expect(MemoryTool.isReadOnly?.()).toBe(false)
    expect(MemoryTool.isConcurrencySafe?.()).toBe(false)
    expect(MemoryTool.name).toBe('Memory')
  })

  it('add via target=memory maps to the global scope with importance label mapping', async () => {
    const { ctx, stop } = await makeContext()
    const result = await MemoryTool.call(
      { action: 'add', target: 'memory', content: 'loves badminton', importance: 'high' },
      ctx,
    )
    try {
      expect(result.is_error).toBeUndefined()
      // Pinned semantics ("tool messages are fixed strings + record ids only"):
      // the confirmation carries deterministic metadata, never a content echo —
      // content is re-read through MemorySearch instead.
      expect(String(result.content)).toMatch(/^Memory saved: \[[0-9a-f-]+\] \(global, high, rev 1\)$/)
      const search = await MemorySearchTool.call({ query: 'badminton' }, ctx)
      expect(String(search.content)).toContain('loves badminton')
    } finally {
      await stop()
    }
  })

  it('workspace target writes to the bound cwd workspace', async () => {
    const { ctx, stop } = await makeContext()
    await MemoryTool.call({ action: 'add', target: 'workspace', content: 'project uses pnpm', importance: 'medium' }, ctx)
    try {
      const search = await MemorySearchTool.call({ query: 'pnpm' }, ctx)
      expect(String(search.content)).toContain('project uses pnpm')
    } finally {
      await stop()
    }
  })

  it('stale revisions surface an actionable conflict message', async () => {
    const { ctx, stop } = await makeContext()
    await MemoryTool.call({ action: 'add', target: 'memory', content: 'v1', importance: 'low' }, ctx)
    const search = await MemorySearchTool.call({ query: 'v1' }, ctx)
    const line = String(search.content).split('\n')[0] // [id] (global, low, rev 1, active) …
    const id = line.slice(1, line.indexOf(']'))
    await MemoryTool.call({ action: 'replace', target: 'memory', record_id: id, expected_revision: 1, new_text: 'v2' }, ctx)
    const conflict = await MemoryTool.call(
      { action: 'replace', target: 'memory', record_id: id, expected_revision: 1, new_text: 'v3' }, ctx)
    try {
      expect(conflict.is_error).toBe(true)
      expect(String(conflict.content)).toContain('revision')
      expect(String(conflict.content)).toContain('2')
    } finally {
      await stop()
    }
  })

  it('remove WITHOUT target stays valid (round-3 review R3-P2)', async () => {
    const { ctx, stop } = await makeContext()
    await MemoryTool.call({ action: 'add', target: 'memory', content: 'compat', importance: 'low' }, ctx)
    const search = await MemorySearchTool.call({ query: 'compat' }, ctx)
    const line = String(search.content).split('\n')[0]
    const id = line.slice(1, line.indexOf(']'))
    // The App's existing contract: {action:"remove", record_id, expected_revision}
    // carries no target — it must keep working (R3-P2).
    const removed = await MemoryTool.call(
      { action: 'remove', record_id: id, expected_revision: 1 }, ctx)
    try {
      expect(removed.is_error).toBeUndefined()
    } finally {
      await stop()
    }
  })

  it('missing service reports a clear error instead of throwing', async () => {
    const { ctx, stop } = await makeContext()
    ;(ctx.services as { memory: unknown }).memory = null
    try {
      const result = await MemoryTool.call({ action: 'add', target: 'memory', content: 'x', importance: 'medium' }, ctx)
      expect(result.is_error).toBe(true)
      expect(String(result.content)).toContain('Memory service is not configured')
    } finally {
      await stop()
    }
  })

  it('rejects an unknown target instead of silently writing workspace (PR review P2)', async () => {
    const { ctx, stop } = await makeContext()
    const result = await MemoryTool.call(
      { action: 'add', target: 'global', content: 'bad target', importance: 'medium' }, ctx)
    expect(result.is_error).toBe(true)
    expect(String(result.content)).toContain('target')
    // nothing was written anywhere:
    const search = await MemorySearchTool.call({ query: 'bad target' }, ctx)
    expect(String(search.content)).toBe('No memory records found.')
    await stop()
  })

  it.each(['toString', '__proto__', 'constructor', 'hasOwnProperty'])(
    'rejects prototype-chain target %s (round-8 review P2)',
    async (inherited) => {
      const { ctx, stop } = await makeContext()
      const result = await MemoryTool.call(
        { action: 'add', target: inherited, content: 'proto target', importance: 'medium' }, ctx)
      expect(result.is_error).toBe(true)
      expect(String(result.content)).toContain('target')
      const search = await MemorySearchTool.call({ query: 'proto target' }, ctx)
      expect(String(search.content)).toBe('No memory records found.')
      await stop()
    })

  it('an already-aborted invocation never writes (PR review P2)', async () => {
    const { ctx, stop } = await makeContext()
    const abortedCtx = { ...ctx, abortSignal: { aborted: true } as AbortSignal }
    const result = await MemoryTool.call(
      { action: 'add', target: 'memory', content: 'should-not-persist', importance: 'medium' }, abortedCtx)
    expect(result.is_error).toBe(true)
    expect(String(result.content)).toContain('aborted')
    // MemorySearch aborts too — and nothing was persisted anywhere:
    const searchAborted = await MemorySearchTool.call({ query: 'should-not-persist' }, abortedCtx)
    expect(searchAborted.is_error).toBe(true)
    const search = await MemorySearchTool.call({ query: 'should-not-persist' }, ctx)
    expect(String(search.content)).toBe('No memory records found.')
    await stop()
  })

  it('cancellation while binding stops the write before the mutation (PR review P2)', async () => {
    const service = createMemoryService({
      storage: new InMemoryMemoryStorage(),
      resolveWorkspace: async (ref: string) => {
        await new Promise((r) => setTimeout(r, 20))
        return defaultMemoryWorkspaceResolver(ref)
      },
    })
    liveServices.push(service)
    await service.start()
    const controller = new AbortController()
    const ctx: ToolContext = {
      cwd: '/repo/a', agentId: 'main', sessionId: 's1',
      services: { memory: service } as unknown as ToolContext['services'],
      subprocessEnv: {}, toolUseId: 'tu1', abortSignal: controller.signal,
    }
    setTimeout(() => controller.abort(), 5) // fires while bind is pending
    const result = await MemoryTool.call(
      { action: 'add', target: 'memory', content: 'late-write', importance: 'medium' }, ctx)
    expect(result.is_error).toBe(true)
    expect(String(result.content)).toContain('aborted')
    const freshCtx = { ...ctx, abortSignal: undefined }
    const search = await MemorySearchTool.call({ query: 'late-write' }, freshCtx)
    expect(String(search.content)).toBe('No memory records found.')
  })
})

describe('MemorySearch tool', () => {
  it('is deferred, read-only, concurrency-safe, and exposes ids/revisions/status', async () => {
    expect(MemorySearchTool.deferred).toBe(true)
    expect(MemorySearchTool.isReadOnly?.()).toBe(true)
    expect(MemorySearchTool.isConcurrencySafe?.()).toBe(true)
    const { ctx, stop } = await makeContext()
    await MemoryTool.call({ action: 'add', target: 'memory', content: 'needle in haystack', importance: 'medium' }, ctx)
    try {
      const result = await MemorySearchTool.call({ query: 'needle' }, ctx)
      expect(String(result.content)).toMatch(/\[[0-9a-f-]+\] \(global, medium, rev 1, active\)/)
    } finally {
      await stop()
    }
  })

  it('returns a fixed empty-result message when nothing matches', async () => {
    const { ctx, stop } = await makeContext()
    try {
      const result = await MemorySearchTool.call({ query: 'nothing matches this' }, ctx)
      expect(result.is_error).toBeUndefined()
      expect(String(result.content)).toBe('No memory records found.')
    } finally {
      await stop()
    }
  })
})

describe('MemoryTool model-facing contract (issue #105)', () => {
  it('documents scopes, writing rules, dedup, and revision safety in the activated description', () => {
    const description = MemoryTool.description
    // memory quality: durable, concise, atomic — not activity logs
    expect(description).toContain('persists across conversations')
    expect(description).toContain('independently searchable')
    expect(description).toContain('activity logs')
    // scope selection guidance
    expect(description).toContain('useful across users and workspaces')
    expect(description).toContain('stable preferences')
    expect(description).toContain('current workspace')
    // deduplication: prefer replace over a competing record
    expect(description).toContain('do not add a second competing record')
    // revision safety: search before write, retry after conflict
    expect(description).toContain('Before replace or remove, call MemorySearch')
    expect(description).toContain('revision conflict')
    // new_text is a full replacement, not a patch
    expect(description).toContain('not a partial patch')
    // action-specific requireds
    expect(description).toContain('add: requires target, content, and importance')
    expect(description).toContain('replace: requires record_id, expected_revision')
    expect(description).toContain('remove: requires record_id and expected_revision')
  })

  it('documents action-specific parameters in schema descriptions without inviting guessing', () => {
    const props = MemoryTool.inputSchema.properties
    expect(props.action.description).toContain('add')
    expect(props.action.description).toContain('replace')
    expect(props.target.description).toContain('Required only for add')
    expect(props.content.description).toContain('Required for add')
    expect(props.new_text.description).toContain('not a patch')
    expect(props.record_id.description).toContain('Required for replace and remove')
    expect(props.record_id.description).toContain('never guess')
    expect(props.expected_revision.description).toContain('Required for replace and remove')
    expect(props.importance.description).toContain('never_forget')
    expect(props.importance.description).toContain('retention priority, not instruction priority')
  })

  it('keeps runtime validation authoritative — only action is structurally required', () => {
    expect(MemoryTool.inputSchema.required).toEqual(['action'])
  })
})

describe('MemorySearchTool model-facing contract (issue #105)', () => {
  it('mandates search-before-write and forbids inventing ids', () => {
    const description = MemorySearchTool.description
    expect(description).toContain('before Memory replace or remove')
    expect(description).toContain('do not invent')
    expect(description).toContain('refine')
  })

  it('bounds limit structurally and documents the default/cap', () => {
    const limit = MemorySearchTool.inputSchema.properties.limit
    expect(limit.minimum).toBe(1)
    expect(limit.maximum).toBe(MEMORY_SEARCH_MAX_LIMIT)
    expect(limit.description).toContain(String(MEMORY_SEARCH_DEFAULT_LIMIT))
    expect(limit.description).toContain(String(MEMORY_SEARCH_MAX_LIMIT))
  })

  it('stays independently deferred with a distinct catalog shortDescription from Memory', () => {
    expect(MemorySearchTool.deferred).toBe(true)
    expect(MemoryTool.deferred).toBe(true)
    expect(MemorySearchTool.shortDescription).not.toBe(MemoryTool.shortDescription)
    expect(MemorySearchTool.shortDescription!.length).toBeLessThanOrEqual(120)
    expect(MemoryTool.shortDescription!.length).toBeLessThanOrEqual(120)
  })
})
import { describe, it, expect, vi, afterEach } from 'vitest'
import { HookRegistry } from './hooks.js'
import type { DiagnosticsSink } from './utils/diagnostics.js'

function makeCollectingSink() {
  const events: Array<{ level: string; msg: string; fields?: unknown; cause?: unknown }> = []
  const sink: DiagnosticsSink = {
    debug: () => {}, trace: () => {},
    warn: (msg, fields) => events.push({ level: 'warn', msg, fields }),
    error: (msg, fields, cause) => events.push({ level: 'error', msg, fields, cause }),
    child: () => sink,
  }
  return { events, sink }
}

describe('HookRegistry diagnostics (#78)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('hook failure sanitized + cause on injected sink', async () => {
    const { events, sink } = makeCollectingSink()
    const registry = new HookRegistry(sink)
    registry.register('PreToolUse', {
      handler: async () => { throw new Error('BOOM-secret') },
    })
    await registry.execute('PreToolUse', { toolName: 'Bash', toolInput: {} } as any)
    const e = events[0]
    expect(e.level).toBe('error')
    expect(e.msg).toBe('[Hook] PreToolUse hook failed')
    expect(e.fields).toEqual({ errorType: 'Error' })
    expect((e.cause as Error).message).toBe('BOOM-secret')
  })

  it('default registry prints sanitized skeleton (no raw error text)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const registry = new HookRegistry()
    registry.register('PreToolUse', {
      handler: async () => { throw new Error('BOOM-secret') },
    })
    await registry.execute('PreToolUse', { toolName: 'Bash', toolInput: {} } as any)
    expect(spy).toHaveBeenCalledWith('[Hook] PreToolUse hook failed', { errorType: 'Error' })
    expect(JSON.stringify(spy.mock.calls)).not.toContain('BOOM-secret')
  })
})

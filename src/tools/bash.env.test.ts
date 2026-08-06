import { describe, it, expect, afterEach } from 'vitest'
import { BashTool } from './bash.js'
import { resolveSubprocessEnv } from '../utils/subprocess-env.js'
import { DefaultToolServices } from './default-services.js'
import type { ToolContext } from '../types.js'

/**
 * Integration tests for BashTool subprocess env handling.
 *
 * Real child process is spawned; the test reads stdout to verify the env
 * the child actually received. Uses `printenv VAR` (POSIX) which prints
 * the value of a single env var (empty if unset) and exits 0 either way.
 *
 * Skip on Windows: `printenv` is not available. Tests use `process.platform`
 * guard; Windows contributors can run these via WSL.
 */
const isWindows = process.platform === 'win32'
const maybeIt = isWindows ? it.skip : it

function makeContext(subprocessEnv: Record<string, string | undefined>): ToolContext {
  return {
    cwd: process.cwd(),
    toolUseId: 'test',
    agentId: 'test-bash-env',
    services: new DefaultToolServices() as any,
    subprocessEnv,
  }
}

async function bashOutput(cmd: string, ctx: ToolContext): Promise<string> {
  const result = await BashTool.call({ command: cmd } as any, ctx)
  return typeof result.content === 'string'
    ? result.content
    : result.content.map((c: any) => (typeof c === 'string' ? c : c.text ?? '')).join('')
}

describe('BashTool subprocess env (integration)', () => {
  const trackedKeys: string[] = []
  const setHost = (k: string, v: string) => { process.env[k] = v; trackedKeys.push(k) }
  afterEach(() => {
    while (trackedKeys.length) delete process.env[trackedKeys.pop()!]
  })

  maybeIt('inherits process.env by default (backward compat)', async () => {
    setHost('BASH_ENV_TEST_HOST', 'host-value')
    const ctx = makeContext(resolveSubprocessEnv({})) // default behavior

    const out = await bashOutput('printenv BASH_ENV_TEST_HOST', ctx)
    expect(out.trim()).toBe('host-value')
  })

  maybeIt('passes toolEnv variables through to subprocess', async () => {
    const ctx = makeContext(resolveSubprocessEnv({
      toolEnv: { BASH_ENV_TEST_TOOL: 'tool-value' },
    }))

    const out = await bashOutput('printenv BASH_ENV_TEST_TOOL', ctx)
    expect(out.trim()).toBe('tool-value')
  })

  maybeIt('toolEnv overrides process.env on key conflict (inherit=true default)', async () => {
    setHost('BASH_ENV_TEST_CONFLICT', 'host')
    const ctx = makeContext(resolveSubprocessEnv({
      toolEnv: { BASH_ENV_TEST_CONFLICT: 'tool-override' },
    }))

    const out = await bashOutput('printenv BASH_ENV_TEST_CONFLICT', ctx)
    expect(out.trim()).toBe('tool-override')
  })

  maybeIt('does NOT inherit process.env when toolEnvInherit=false', async () => {
    setHost('BASH_ENV_TEST_SECRET', 'leaked-secret')
    // Provide minimum env for `env` to work at all
    const ctx = makeContext(resolveSubprocessEnv({
      toolEnv: {
        PATH: process.env.PATH!,
        // `env` itself needs no other vars
      },
      toolEnvInherit: false,
    }))

    // Use `env` to list all variables in subprocess; SECRET should not appear.
    const allEnv = await bashOutput('env', ctx)
    expect(allEnv).not.toContain('BASH_ENV_TEST_SECRET')
    expect(allEnv).not.toContain('leaked-secret')

    // Sanity: PATH must still be there so `env` could run
    expect(allEnv).toMatch(/PATH=/)
  })
})

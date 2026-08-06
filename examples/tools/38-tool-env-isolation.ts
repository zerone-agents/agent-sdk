/**
 * Example 38: Tool Subprocess Environment Isolation
 *
 * Shows how to control what environment variables Bash/Grep subprocesses
 * can see. Useful when embedding the SDK in a host app (Next.js standalone,
 * Electron, etc.) that has runtime-only vars you don't want leaking into
 * arbitrary shell commands run by the agent.
 *
 * Key options:
 *   - toolEnv: explicit env vars passed to Bash/Grep subprocesses
 *   - toolEnvInherit (default true):
 *       true  → merge toolEnv over process.env (toolEnv wins on conflict)
 *       false → use toolEnv only, process.env is fully hidden
 *
 * This example doesn't require an LLM API key — it constructs the agent
 * and then calls BashTool directly so you can see the env behavior without
 * a real model call.
 *
 * Run: npx tsx examples/tools/38-tool-env-isolation.ts
 */
import { createAgent } from '../../src/index.js'
import { BashTool } from '../../src/tools/bash.js'
import { resolveSubprocessEnv } from '../../src/utils/subprocess-env.js'
import type { ToolContext } from '../../src/types.js'
import { DefaultToolServices } from '../../src/tools/default-services.js'

// Simulate a host app that has runtime vars the SDK shouldn't leak.
// (Next.js standalone, Electron, server-only tokens, etc.)
process.env.__HOST_APP_PRIVATE_TOKEN = 'should-not-leak'
process.env.__HOST_TURBOPACK = '1'
process.env.USER_VISIBLE_VAR = 'host-value'

async function runBash(
  label: string,
  opts: { toolEnv?: Record<string, string | undefined>; toolEnvInherit?: boolean },
): Promise<void> {
  console.log(`\n=== ${label} ===`)
  console.log('  opts:', JSON.stringify(opts))

  // Construct an agent with the chosen env options. Agent build snapshots
  // process.env once and pre-computes subprocessEnv on AgentEnvironment.
  //
  // We construct purely for documentation — in this offline demo we don't
  // run agent.prompt() (which would require an API key). To verify what
  // env the subprocess would actually receive, we call the same helper
  // the agent uses and inspect the result.
  createAgent({
    apiKey: 'unused', // we won't actually call the LLM
    ...opts,
  })

  const subprocessEnv = resolveSubprocessEnv(opts)

  const ctx: ToolContext = {
    cwd: process.cwd(),
    toolUseId: 'demo',
    agentId: 'tool-env-demo',
    services: new DefaultToolServices() as any,
    subprocessEnv,
  }

  // Print what the subprocess would actually see
  const result = await BashTool.call(
    { command: 'env | sort | grep -E "__HOST|USER_VISIBLE" || echo "(no matching vars)"' } as any,
    ctx,
  )
  const output = typeof result.content === 'string'
    ? result.content
    : result.content.map((c: any) => (typeof c === 'string' ? c : c.text ?? '')).join('')
  console.log('  subprocess sees:')
  for (const line of output.trim().split('\n')) {
    console.log(`    ${line}`)
  }
}

async function main(): Promise<void> {
  console.log('--- Example 38: Tool Subprocess Environment Isolation ---')

  console.log('\nHost process.env has:')
  for (const k of ['__HOST_APP_PRIVATE_TOKEN', '__HOST_TURBOPACK', 'USER_VISIBLE_VAR']) {
    console.log(`  ${k}=${process.env[k]}`)
  }

  // 1. Default behavior: full inheritance. Subprocess sees everything.
  await runBash('Default (no toolEnv options — backward compat)', {})

  // 2. Add a tool-only var; everything else still inherits.
  await runBash('Add a tool-specific var (still inherits process.env)', {
    toolEnv: { MY_TOOL_VAR: 'injected' },
  })

  // 3. Override an existing var (toolEnv wins on key conflict).
  await runBash('Override USER_VISIBLE_VAR via toolEnv', {
    toolEnv: { USER_VISIBLE_VAR: 'overridden-by-toolEnv' },
  })

  // 4. Full isolation: only PATH + safe vars reach the subprocess.
  //    The host's __HOST_* and signing tokens never leak.
  await runBash('Full isolation (toolEnvInherit: false)', {
    toolEnv: {
      PATH: process.env.PATH!,         // required for `env`/`grep` to run
      HOME: process.env.HOME!,         // common shell expectation
      MY_SAFE_VAR: 'explicitly-allowed',
    },
    toolEnvInherit: false,
  })
}

main().catch(console.error)

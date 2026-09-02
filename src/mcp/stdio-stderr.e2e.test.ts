// Real-subprocess regression for issue #87: a stdio MCP child's stderr must
// only reach the host when policy allows. Drives the REAL connectMCPServer
// inside a tsx wrapper process and asserts from the wrapper's complete
// stdout+stderr boundary. Never touches process-level global streams.
import { describe, it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const WRAPPER = new URL('./fixtures/stdio-stderr-wrapper.ts', import.meta.url).pathname

async function runWrapper(policy: '-' | 'ignore', secret: string): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(
      'npx', ['tsx', WRAPPER, policy, secret],
      { timeout: 60_000, env: { ...process.env } },
    )
    return stdout + stderr
  } catch (err: any) {
    // Non-zero wrapper exit = harness failure; surface captured output so the
    // assertion diff explains what happened.
    return `${err.stdout ?? ''}${err.stderr ?? ''}${err.message ?? ''}`
  }
}

function makeSecret(): string {
  return `SECRET_87_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

describe('stdio child stderr policy — real subprocess (issue #87)', () => {
  it('stderr: "ignore" keeps the child secret out of the parent output boundary', async () => {
    const secret = makeSecret()
    const output = await runWrapper('ignore', secret)
    expect(output).toContain('status=error')   // child exits 1 → error connection (expected)
    expect(output).not.toContain(secret)
  }, 90_000)

  it('omitted stderr keeps upstream inherit (positive control: the harness CAN observe a leak)', async () => {
    const secret = makeSecret()
    const output = await runWrapper('-', secret)
    expect(output).toContain('status=error')
    expect(output).toContain(secret)
  }, 90_000)
})

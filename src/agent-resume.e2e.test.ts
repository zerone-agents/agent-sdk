// Cross-process regression for issue #115: two sequential node processes
// (activate+save, then resume) — same-process memory sharing cannot mask a
// persistence bug. Spawn pattern: src/mcp/stdio-stderr.e2e.test.ts.
import { describe, it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const FIXTURE = new URL('./agent-resume.e2e.fixture.ts', import.meta.url).pathname
const MEMORY_TXT = readFileSync(fileURLToPath(new URL('./tools/memory.txt', import.meta.url)), 'utf-8')

async function runPhase(args: string[], home: string): Promise<string> {
  const { stdout } = await execFileAsync('npx', ['tsx', FIXTURE, ...args],
    { timeout: 90_000, env: { ...process.env, HOME: home } })
  return stdout
}

describe('deferred activation resume — cross-process (issue #115)', () => {
  it('activations survive a process restart with full descriptions', async () => {
    const home = mkdtempSync(join(tmpdir(), 'e2e115-'))
    const outA = await runPhase(['a'], home)
    const sid = outA.match(/SID=(\S+)/)?.[1]
    expect(sid).toBeTruthy()

    const outB = await runPhase(['b', sid!], home)
    const tools = JSON.parse(outB.match(/TOOLS=(.*)/)![1]) as any[]
    expect(tools.map(t => t.name).sort()).toEqual(['Memory', 'MemorySearch'])
    const mem = tools.find(t => t.name === 'Memory')
    expect(mem.description).toBe(MEMORY_TXT)   // full text across processes
  }, 180_000)
})

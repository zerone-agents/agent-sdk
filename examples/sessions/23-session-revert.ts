/**
 * Example 23: Session Revert with File Snapshot
 *
 * Full end-to-end: LLM creates files → revert undoes both conversation + files.
 *
 * Flow:
 *   1. Create temp workspace + git init
 *   2. createAgent({ snapshotEngine }) — SDK auto-tracks _snapshot per turn
 *   3. Round 1: LLM creates counter.txt = "1"
 *   4. Round 2: LLM edits counter.txt = "2"
 *   5. revertSession: file back to pre-round-1 state, conversation truncated
 *   6. Resume and continue from the reverted state
 *
 * Run: npx tsx examples/23-session-revert.ts
 * Requires: ANTHROPIC_API_KEY env var and git installed.
 */

import {
  createAgent,
  SnapshotEngine,
  revertSession,
  loadSession,
} from '../../src/index.js'
import { mkdtemp, rm, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

async function main() {
  console.log('=== Example 23: Session Revert with File Snapshot ===\n')

  const workdir = await mkdtemp(join(tmpdir(), 'revert-demo-'))
  console.log(`Workspace: ${workdir}`)

  const { execFile } = await import('child_process')
  const { promisify } = await import('util')
  const exec = promisify(execFile)
  await exec('git', ['init'], { cwd: workdir })

  const snapshotEngine = new SnapshotEngine({ worktree: workdir })
  await snapshotEngine.init()
  console.log('SnapshotEngine initialized\n')

  const agent = createAgent({
    model: process.env.ZERONE_AGENT_MODEL || 'claude-sonnet-4-6',
    agent: { description: 'Session revert demo agent', prompt: { type: 'preset', preset: 'default' }, maxTurns: 5 },
    cwd: workdir,
    persistSession: true,
    snapshotEngine,
  })

  async function readFileSafe(path: string): Promise<string | null> {
    try { return await readFile(path, 'utf-8') } catch { return null }
  }

  // === Round 1: Create counter.txt ===
  console.log('--- Round 1: Create counter.txt ---')
  await agent.prompt(
    'Create a file called counter.txt in the current directory with exactly: 1\n' +
    'Use the Write tool.'
  )
  const content1 = await readFileSafe(join(workdir, 'counter.txt'))
  console.log(`counter.txt = "${content1}"\n`)

  // === Round 2: Modify counter.txt ===
  console.log('--- Round 2: Modify counter.txt ---')
  await agent.prompt(
    'Read counter.txt, then use the Edit tool to change "1" to "2".'
  )
  const content2 = await readFileSafe(join(workdir, 'counter.txt'))
  console.log(`counter.txt = "${content2}"\n`)

  const sessionId = agent.getSessionId()
  await agent.close()

  // === Revert: standalone session-level operation ===
  console.log('--- Revert: Undo everything back to round 1 ---')
  const data = await loadSession(sessionId)
  const round1UserMsg = data?.messages.find((m: any) => m.role === 'user' && m.id)
  const targetId = round1UserMsg?.id

  if (!targetId) {
    console.log('❌ Could not find round 1 user message ID')
    return
  }

  const result = await revertSession(sessionId, targetId, {
    cwd: workdir,
    snapshotEngine,
  })
  console.log(`Changed files: [${result.changedFiles.join(', ')}]`)

  const contentReverted = await readFileSafe(join(workdir, 'counter.txt'))
  console.log(`counter.txt = "${contentReverted}"`)
  console.log(contentReverted === null ? '✅ File deleted (did not exist before round 1)\n' : '❌ File still exists\n')

  // === Resume and continue from reverted state ===
  console.log('--- Round 3: Continue after revert ---')
  const agent2 = createAgent({
    model: process.env.ZERONE_AGENT_MODEL || 'claude-sonnet-4-6',
    agent: { description: 'Session revert resume agent', prompt: { type: 'preset', preset: 'default' }, maxTurns: 5 },
    cwd: workdir,
    persistSession: true,
    resume: sessionId,
    snapshotEngine,
  })

  await agent2.prompt(
    'Create a file called counter.txt with exactly: 99\n' +
    'Use the Write tool.'
  )
  const content3 = await readFileSafe(join(workdir, 'counter.txt'))
  console.log(`counter.txt = "${content3}"\n`)

  await agent2.close()

  // === Summary ===
  console.log('=== Summary ===')
  console.log(`Round 1:   counter.txt = "${content1}"`)
  console.log(`Round 2:   counter.txt = "${content2}"`)
  console.log(`Revert:    counter.txt = "${contentReverted}" (deleted)`)
  console.log(`Round 3:   counter.txt = "${content3}" (new direction)`)
  console.log(`\nWorkspace: ${workdir}`)
}

/**
 * Test: Pure chat revert — verify reverted context is truly lost.
 */
async function chatRevertTest() {
  console.log('\n\n=== Chat Revert Test: Context Loss Verification ===\n')

  const agent = createAgent({
    model: process.env.ZERONE_AGENT_MODEL || 'claude-sonnet-4-6',
    agent: { description: 'Chat revert test baseline agent', prompt: { type: 'preset', preset: 'default' }, maxTurns: 3 },
    persistSession: true,
  })

  console.log('--- Round 1: Baseline context ---')
  await agent.prompt('I like the color blue. Just acknowledge briefly.')

  console.log('--- Round 2: Tell secret ---')
  await agent.prompt('Remember: my secret code is 7331. Just acknowledge briefly.')

  console.log('--- Verify: LLM knows the secret ---')
  const rCheck = await agent.prompt('What is my secret code?')
  const knewBefore = rCheck.text.includes('7331')
  console.log(`  Knows secret: ${knewBefore ? '✅' : '❌'}\n`)

  const sessionId = agent.getSessionId()
  await agent.close()

  // Revert standalone
  console.log('--- Revert: Remove round 2 + verification ---')
  const data = await loadSession(sessionId)
  const round2User = data?.messages.find((m: any) =>
    m.role === 'user' && typeof m.content === 'string' && m.content.includes('secret code')
  )
  if (!round2User?.id) { console.log('❌ Cannot find round 2 message'); return }

  await revertSession(sessionId, round2User.id)
  console.log(`  Reverted.\n`)

  // Resume and ask for the secret
  console.log('--- Round 3: Ask for secret (after revert) ---')
  const agent2 = createAgent({
    model: process.env.ZERONE_AGENT_MODEL || 'claude-sonnet-4-6',
    agent: { description: 'Chat revert test verification agent', prompt: { type: 'preset', preset: 'default' }, maxTurns: 3 },
    persistSession: true,
    resume: sessionId,
  })
  const r3 = await agent2.prompt('What is my secret code?')
  const knowsAfter = r3.text.includes('7331')
  console.log(`  LLM says: ${r3.text.slice(0, 80)}`)
  console.log(`  Knows secret: ${knowsAfter ? '❌ leaked!' : '✅ lost'}\n`)

  await agent2.close()

  console.log('=== Verdict ===')
  if (knewBefore && !knowsAfter) {
    console.log('✅ Revert works — reverted context is truly lost from LLM memory')
  } else if (!knewBefore) {
    console.log('⚠️ LLM never learned the secret (test setup issue)')
  } else {
    console.log('❌ Revert failed — context leaked')
  }
}

main().then(() => chatRevertTest()).catch(console.error)

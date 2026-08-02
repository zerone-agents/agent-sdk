/**
 * Example 26: Session-level Revert — Standalone + Resume
 *
 * Shows the recommended flow:
 *   revertSession → createAgent({ resume }) → query → close
 *
 * Run: npx tsx examples/26-agent-revert-api.ts
 * Requires: ZERONE_AGENT_API_KEY + git installed
 */

import { createAgent, SnapshotEngine, revertSession, loadSession } from '../../src/index.js'
import { mkdtemp, rm, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

async function main() {
  console.log('=== Session-level Revert: Standalone + Resume ===\n')

  const workdir = await mkdtemp(join(tmpdir(), 'api-test-'))
  const { execFile } = await import('child_process')
  const { promisify } = await import('util')
  const exec = promisify(execFile)
  await exec('git', ['init'], { cwd: workdir })
  console.log(`Workspace: ${workdir}`)

  const snapshotEngine = new SnapshotEngine({ worktree: workdir })
  await snapshotEngine.init()

  // --- Round 1 + 2 ---
  const agent = createAgent({
    model: process.env.ZERONE_AGENT_MODEL || 'claude-sonnet-4-6',
    agent: { description: 'Revert API test agent', prompt: { type: 'preset', preset: 'default' }, maxTurns: 3 },
    cwd: workdir,
    snapshotEngine,
    persistSession: true,
  })

  console.log('\n--- Round 1 ---')
  await agent.prompt('Create a file called log.txt with content: v1')
  console.log(`log.txt = "${await readFile(join(workdir, 'log.txt'), 'utf-8')}"`)

  console.log('\n--- Round 2 ---')
  await agent.prompt('Change log.txt content to: v2')
  console.log(`log.txt = "${await readFile(join(workdir, 'log.txt'), 'utf-8')}"`)

  const sessionId = agent.getSessionId()
  await agent.close()

  // --- Revert standalone (no Agent instance) ---
  console.log('\n--- Revert round 2 ---')
  const data = await loadSession(sessionId)
  const targetMsg = [...(data?.messages ?? [])].reverse().find((m) => m.role === 'user')

  if (targetMsg?.id) {
    const result = await revertSession(sessionId, targetMsg.id, {
      cwd: workdir,
      snapshotEngine,
    })
    console.log(`Changed files: [${result.changedFiles.join(', ')}]`)
    console.log(`log.txt = "${await readFile(join(workdir, 'log.txt'), 'utf-8')}"`)
  }

  // --- Resume from reverted state and continue ---
  console.log('\n--- Continue after revert ---')
  const agent2 = createAgent({
    model: process.env.ZERONE_AGENT_MODEL || 'claude-sonnet-4-6',
    agent: { description: 'Revert resume agent', prompt: { type: 'preset', preset: 'default' }, maxTurns: 3 },
    cwd: workdir,
    snapshotEngine,
    resume: sessionId,
    persistSession: true,
  })
  await agent2.prompt('Create log.txt with content: v3')
  console.log(`log.txt = "${await readFile(join(workdir, 'log.txt'), 'utf-8')}"`)
  await agent2.close()

  // --- Scenario B: Reopen, revert from history ---
  console.log('\n--- Scenario B: Reopen + Revert ---')
  const agent3 = createAgent({
    model: process.env.ZERONE_AGENT_MODEL || 'claude-sonnet-4-6',
    agent: { description: 'Revert history reopen agent', prompt: { type: 'preset', preset: 'default' }, maxTurns: 3 },
    cwd: workdir,
    snapshotEngine,
    resume: sessionId,
    persistSession: true,
  })

  const history = await agent3.getMessageHistory()
  console.log(`Loaded ${history.length} messages from session`)
  await agent3.close()

  const firstUser = history.find((m) => m.role === 'user')
  if (firstUser?.id) {
    console.log(`Reverting to: ${firstUser.id.slice(0, 8)}`)
    const result = await revertSession(sessionId, firstUser.id, {
      cwd: workdir,
      snapshotEngine,
    })
    console.log(`Changed files: [${result.changedFiles.join(', ')}]`)
    const fileExists = await readFile(join(workdir, 'log.txt'), 'utf-8').then(() => true).catch(() => false)
    console.log(`log.txt exists: ${fileExists}`)
  }

  await rm(workdir, { recursive: true, force: true })
  console.log('\nDone!')
}

main().catch(console.error)

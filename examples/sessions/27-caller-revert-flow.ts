/**
 * Example 27: Caller Revert Flow — Host Integration Guide
 *
 * Complete revert lifecycle on the `revertSession → createAgent → resume → query → close` route.
 *
 * Revert is a standalone session-level operation. It does NOT need an Agent
 * instance. The recommended flow is:
 *
 *   1. revertSession(sessionId, messageId)   — rollback files + truncate transcript
 *   2. createAgent({ resume: sessionId })    — load the reverted state
 *   3. agent.query(text)                     — continue from the reverted point
 *   4. agent.close()                         — persist + gc
 *
 * Run: npx tsx examples/27-caller-revert-flow.ts
 */

import { createAgent, forkSession, revertSession, loadSession } from '../../src/index.js'
import { rm } from 'fs/promises'
import { join } from 'path'

const MODEL = process.env.ZERONE_AGENT_MODEL || 'claude-sonnet-4-6'

async function main() {
  const cwd = process.cwd()
  const scratchFile = join(cwd, 'src', 'hello.ts')

  try {
    // ========================================================================
    // Phase 1 — Normal conversation (first run)
    // ========================================================================

    const agent = createAgent({
      model: MODEL,
      cwd,
      agent: { description: 'Caller revert flow phase-1 agent', prompt: { type: 'preset', preset: 'default' }, maxTurns: 3 },
      persistSession: true,
    })

    await agent.prompt('Create a hello.ts under src/')
    await agent.prompt('Add type annotations to hello.ts')

    const sessionId = agent.getSessionId()
    console.log(`session: ${sessionId}`)

    await agent.close()

    // ========================================================================
    // Phase 2 — Revert before creating a new Agent
    // ========================================================================
    //
    // revertSession reads transcript.json, rolls back files via SnapshotEngine
    // (if git available), truncates messages at the anchor, writes back.
    // No Agent instance needed — call it from anywhere.

    // Load history to find the target message id.
    const data = await loadSession(sessionId)
    const messages = data?.messages ?? []
    const secondUser = messages.filter((m) => m.role === 'user')[1]

    if (secondUser?.id) {
      const result = await revertSession(sessionId, secondUser.id, { cwd })
      console.log(`\nreverted files: ${result.changedFiles.join(', ') || '(none)'}`)
      // transcript.json is now truncated; files are rolled back.
    }

    // ========================================================================
    // Phase 3 — Resume the reverted session and continue
    // ========================================================================

    const agent2 = createAgent({
      model: MODEL,
      cwd,
      agent: { description: 'Caller revert flow phase-3 resume agent', prompt: { type: 'preset', preset: 'default' }, maxTurns: 3 },
      resume: sessionId,
      persistSession: true,
    })

    // History reflects the reverted state.
    const history = await agent2.getMessageHistory()
    console.log(`messages after revert: ${history.length}`)

    // Continue from the reverted state.
    for await (const ev of agent2.query('Now add a comment: this is version 2')) {
      if (ev.type === 'result') {
        console.log(`query done: turns=${ev.num_turns}`)
      }
    }

    await agent2.close()

    // ========================================================================
    // Phase 4 — Fork as undo (optional)
    // ========================================================================
    //
    // There is no unrevert. If the user wants to preserve a branch before
    // trying something risky, fork first.

    // Load history to find fork point.
    const data3 = await loadSession(sessionId)
    const forkedId = await forkSession({
      sessionId,
      messageId: data3?.messages[0]?.id,
    })
    console.log(`\nforked session: ${forkedId}`)

    // ========================================================================
    // Summary
    // ========================================================================

    console.log('\n=== Lifecycle ===')
    console.log('revertSession → createAgent({ resume }) → query → close')
    console.log('Revert is standalone; Agent only needs to resume the result.')
  } finally {
    // Clean up the scratch file the agent wrote into the host repo.
    // Revert degrades to conversation-only when no snapshot is available,
    // so the file may survive — remove it explicitly to avoid polluting cwd.
    await rm(scratchFile, { force: true })
  }
}

main().catch(console.error)

// ===========================================================================
// API cheat sheet
// ===========================================================================
//
// Revert (standalone — no Agent needed):
//   await revertSession(sessionId, messageId, { cwd })
//   // → reads transcript, rolls back files, truncates messages, writes back
//
// Resume the reverted session:
//   const agent = createAgent({ resume: sessionId })
//
// Talk:
//   for await (const ev of agent.query(text)) { ... }
//   await agent.getMessageHistory()   // messages with ids
//
// Fork (undo alternative — also standalone):
//   const forkId = await forkSession({ sessionId, messageId })
//   const forkId = await forkSession({ sessionId, messageId }, undefined, { preserveIds: true })
//
// Close (runs gc once, persists session):
//   await agent.close()
//
// Key properties:
//   - Revert is stateless: reads transcript → rolls back → writes transcript
//   - No unrevert; fork before reverting if you need a backup
//   - Fork strips _snapshot → conversation revert only, no file revert
//   - _snapshot.beforeHash may be pruned by gc after 7 days;
//     revert degrades gracefully to conversation-only in that case

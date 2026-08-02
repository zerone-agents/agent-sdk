/**
 * Example 25: Revert & Fork — API Cheat Sheet
 *
 * Stateless session-level revert.
 *
 * Run: npx tsx examples/25-revert-fork-guide.ts
 */

import { createAgent, forkSession, revertSession, loadSession } from '../../src/index.js'

async function main() {
  const cwd = process.cwd()

  const agent = createAgent({
    model: process.env.ZERONE_AGENT_MODEL || 'claude-sonnet-4-6',
    cwd,
    agent: { description: 'Revert & fork cheat-sheet agent', prompt: { type: 'preset', preset: 'default' }, maxTurns: 3 },
    persistSession: true,
  })

  await agent.prompt('Create src/hello.ts')
  await agent.prompt('Add type annotations to hello.ts')

  const sessionId = agent.getSessionId()
  await agent.close()

  // ---- Revert directly on the session (no Agent needed) ----
  const data = await loadSession(sessionId)
  const targetId = data?.messages.find((m) => m.role === 'user')?.id
  if (targetId) {
    const result = await revertSession(sessionId, targetId, { cwd })
    console.log(`reverted files: ${result.changedFiles.join(', ') || '(none)'}`)
  }

  // ---- Fork after revert (default: regenerate IDs) ----
  const data2 = await loadSession(sessionId)
  const forkedId = await forkSession({
    sessionId,
    messageId: data2?.messages[0]?.id,
  })
  console.log(`forked session: ${forkedId}`)

  // ---- Fork while preserving original message IDs ----
  const forkedPreserveId = await forkSession(
    { sessionId, messageId: data2?.messages[0]?.id },
    undefined,
    { preserveIds: true },
  )
  console.log(`forked session (preserveIds): ${forkedPreserveId}`)
}

main().catch(console.error)

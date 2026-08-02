/**
 * Example 24: Fork From Message
 *
 * Demonstrates conversation branching — fork from a specific message
 * to explore a different direction while keeping the original session.
 *
 * Flow:
 *   1. Session A: LLM creates a plan → "use approach X"
 *   2. Fork from the user prompt of round 1 → Session B
 *   3. Session B: ask LLM to "use approach Y instead"
 *   4. Compare: Session A and B diverge from the same point
 *
 * Run: npx tsx examples/24-fork-from-message.ts
 * Requires: ANTHROPIC_API_KEY env var (or ZERONE_AGENT_API_KEY)
 */

import { createAgent, forkSession, loadSession } from '../../src/index.js'

async function main() {
  console.log('=== Example 24: Fork From Message ===\n')

  // === Session A: original conversation ===
  console.log('--- Session A: Original ---')
  const agentA = createAgent({
    model: process.env.ZERONE_AGENT_MODEL || 'claude-sonnet-4-6',
    agent: { description: 'Fork-from-message Session A agent', prompt: { type: 'preset', preset: 'default' }, maxTurns: 3 },
    persistSession: true,
  })

  console.log('> What is 2+2? Answer in one word.')
  await agentA.prompt('What is 2+2? Answer in one word.')
  console.log(`  Session A messages: ${agentA.getMessages().length}\n`)

  // Get session A's ID and the first assistant message (fork point)
  const sidA = (agentA as any).sid as string
  const engineA = (agentA as any).currentEngine
  const firstAssistantMsg = engineA?.messages?.find((m: any) => m.role === 'assistant')

  if (!firstAssistantMsg?.id) {
    console.log('❌ Could not find first assistant message ID')
    return
  }
  console.log(`Session A ID: ${sidA}`)
  console.log(`Fork point (first assistant message): ${firstAssistantMsg.id}\n`)

  // === Fork 1: create Session B from Session A's first exchange (default) ===
  console.log('--- Fork: Session B from Session A (after first exchange) ---')
  const sidB = await forkSession({
    sessionId: sidA,
    messageId: firstAssistantMsg.id,
  })

  if (!sidB) {
    console.log('❌ Fork failed')
    return
  }
  console.log(`Session B ID: ${sidB}\n`)

  // === Fork 2: preserve original message IDs ===
  console.log('--- Fork: Session C from Session A (preserveIds=true) ---')
  const sidC = await forkSession(
    {
      sessionId: sidA,
      messageId: firstAssistantMsg.id,
    },
    undefined,
    { preserveIds: true },
  )

  if (!sidC) {
    console.log('❌ Preserve-ID fork failed')
    return
  }
  console.log(`Session C ID: ${sidC}\n`)

  // === Session B: different direction ===
  console.log('--- Session B: Different direction ---')
  const agentB = createAgent({
    model: process.env.ZERONE_AGENT_MODEL || 'claude-sonnet-4-6',
    agent: { description: 'Fork-from-message Session B agent', prompt: { type: 'preset', preset: 'default' }, maxTurns: 3 },
    persistSession: true,
    resume: sidB,
  })

  console.log('> What is 3+3? Answer in one word.')
  await agentB.prompt('What is 3+3? Answer in one word.')
  console.log(`  Session B messages: ${agentB.getMessages().length}\n`)

  // === Compare sessions ===
  console.log('=== Comparison ===')

  const dataA = await loadSession(sidA)
  const dataB = await loadSession(sidB)
  const dataC = await loadSession(sidC)

  if (dataA && dataB && dataC) {
    console.log(`Session A (${sidA.slice(0, 8)}): ${dataA.messages.length} messages`)
    for (const msg of dataA.messages) {
      const preview = typeof msg.content === 'string'
        ? msg.content.slice(0, 50)
        : Array.isArray(msg.content)
          ? msg.content.map((b: any) => b.type === 'text' ? b.text.slice(0, 50) : `[${b.type}]`).join(' ')
          : ''
      console.log(`  [${msg.role}] id=${(msg.id ?? '?').slice(0, 8)}  ${preview}`)
    }

    console.log(`\nSession B (${sidB.slice(0, 8)}): ${dataB.messages.length} messages`)
    for (const msg of dataB.messages) {
      const preview = typeof msg.content === 'string'
        ? msg.content.slice(0, 50)
        : Array.isArray(msg.content)
          ? msg.content.map((b: any) => b.type === 'text' ? b.text.slice(0, 50) : `[${b.type}]`).join(' ')
          : ''
      console.log(`  [${msg.role}] id=${(msg.id ?? '?').slice(0, 8)}  ${preview}`)
    }

    console.log(`\nSession C (${sidC.slice(0, 8)}): ${dataC.messages.length} messages`)
    for (const msg of dataC.messages) {
      const preview = typeof msg.content === 'string'
        ? msg.content.slice(0, 50)
        : Array.isArray(msg.content)
          ? msg.content.map((b: any) => b.type === 'text' ? b.text.slice(0, 50) : `[${b.type}]`).join(' ')
          : ''
      console.log(`  [${msg.role}] id=${(msg.id ?? '?').slice(0, 8)}  ${preview}`)
    }

    // Verify: default fork regenerates IDs; preserveIds fork keeps them
    const idsA = new Set(dataA.messages.map((m) => m.id))
    const idsB = new Set(dataB.messages.map((m) => m.id))
    const idsC = new Set(dataC.messages.map((m) => m.id))
    const overlapB = [...idsA].filter((id) => idsB.has(id))
    const overlapC = [...idsA].filter((id) => idsC.has(id))
    console.log(`\nMessage ID overlap with Session B: ${overlapB.length} (default: should be 0)`)
    console.log(`Message ID overlap with Session C: ${overlapC.length} (preserveIds: should be > 0)`)
  }

  console.log(`\nSession A dir: ~/.agents/sessions/${sidA}/`)
  console.log(`Session B dir: ~/.agents/sessions/${sidB}/`)
  console.log(`Session C dir: ~/.agents/sessions/${sidC}/`)
}

main().catch(console.error)

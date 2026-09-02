/**
 * Example 31: Session Context Query Limit (maxSessionQueries)
 *
 * Demonstrates how maxSessionQueries bounds the conversation via halved
 * compaction: when the session exceeds N queries, the older half is
 * summarized by the LLM and the summary replaces it in the persistent
 * transcript, while the most recent half is kept verbatim.
 *
 * The example runs 5 turns of conversation. Each turn asks the agent to
 * remember a number. With maxSessionQueries: 2, queries beyond the limit are
 * compacted into a summary — so the agent can still recall earlier numbers
 * from the summary even though their raw messages are gone.
 *
 * Key points:
 * - On overflow, the persistent transcript is rewritten to
 *   [summary pair, ...recent half] (old raw queries are NOT preserved)
 * - Compaction reuses the standard compact flow and emits `compact` events
 * - If the summary call fails, the engine falls back to hard truncation
 * - maxSessionQueries can be set at agent creation or overridden per-query
 *
 * Run: npx tsx examples/sessions/31-session-turn-limit.ts
 */
import { createAgent, truncateToLastNQueries } from '../../src/index.js'
import type { NormalizedMessageParam } from '../../src/providers/types.js'

async function main() {
  console.log('--- Example 31: Session Context Query Limit (maxSessionQueries) ---\n')

  const agent = createAgent({
    model: process.env.ZERONE_AGENT_MODEL || 'claude-sonnet-4-6',
    agent: { description: 'Session turn limit agent', prompt: { type: 'preset', preset: 'default' }, maxTurns: 3 },
    maxSessionQueries: 2,
  })

  const turns = [
    'Remember the number 42. Just say "OK, I will remember 42." and nothing else.',
    'Remember the number 17. Just say "OK, I will remember 17." and nothing else.',
    'Remember the number 99. Just say "OK, I will remember 99." and nothing else.',
    'Remember the number 55. Just say "OK, I will remember 55." and nothing else.',
    'What numbers have I asked you to remember? List them all.',
  ]

  for (let i = 0; i < turns.length; i++) {
    console.log(`> Turn ${i + 1}: ${turns[i]}`)
    const result = await agent.prompt(turns[i], {
      // Dynamically override maxSessionQueries per query
      maxSessionQueries: i < 4 ? 2 : 3,
    })
    console.log(`  ${result.text}`)
    console.log(`  Tokens: ${result.usage.input_tokens} in / ${result.usage.output_tokens} out`)
    console.log(`  Audit log:       ${agent.getMessageLog().length} messages`)
    console.log(`  Engine history:  ${(await agent.getMessageHistory()).length} messages (post-compaction)\n`)
  }

  // Show the persistent transcript: old queries have been replaced by a
  // summary, recent queries remain verbatim.
  const fullMessages = await agent.getMessageHistory()
  console.log('--- Persistent transcript (older queries compacted into a summary) ---')
  for (const msg of fullMessages) {
    const role = msg.role
    const content = msg.content
    if (typeof content === 'string') {
      console.log(`  [${role}] ${content.slice(0, 80)}`)
    } else if (Array.isArray(content)) {
      const text = content
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text)
        .join(' ')
      console.log(`  [${role}] ${text.slice(0, 80)}`)
    }
  }

  // Demonstrate the utility function directly. truncateToLastNQueries is the
  // hard-truncation fallback used when the summary call fails.
  console.log('\n--- truncateToLastNQueries() utility demo (fallback path) ---')
  const sampleMessages: NormalizedMessageParam[] = [
    { role: 'user', content: 'turn 1' },
    { role: 'assistant', content: 'response 1' },
    { role: 'user', content: 'turn 2' },
    { role: 'assistant', content: 'response 2' },
    { role: 'user', content: 'turn 3' },
    { role: 'assistant', content: 'response 3' },
  ]
  const last2 = truncateToLastNQueries(sampleMessages, 2)
  console.log(`  Original: ${sampleMessages.length} messages (3 queries)`)
  console.log(`  After truncateToLastNQueries(msgs, 2): ${last2.length} messages (last 2 queries)`)
  console.log(`  First message: ${(last2[0].content as string)}\n`)

  await agent.close()
}

main().catch(console.error)

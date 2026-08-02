/**
 * Example 31: Session Context Round Limit (maxSessionTurns)
 *
 * Demonstrates how maxSessionTurns limits the conversation rounds sent to
 * the LLM API while the session transcript retains the full history.
 *
 * The example runs 5 turns of conversation. Each turn asks the agent to
 * remember a number. With maxSessionTurns: 2, the LLM only sees the last
 * 2 rounds on each call — so it "forgets" numbers from earlier turns.
 *
 * Key points:
 * - Session transcript (agent.getMessages()) always has ALL messages
 * - Only the API call is truncated to the last N rounds
 * - maxSessionTurns can be set at agent creation or overridden per-query
 *
 * Run: npx tsx examples/31-session-turn-limit.ts
 */
import { createAgent, truncateToLastNTurns } from '../../src/index.js'
import type { NormalizedMessageParam } from '../../src/providers/types.js'
import type { Message } from '../../src/types.js'

async function main() {
  console.log('--- Example 31: Session Context Round Limit (maxSessionTurns) ---\n')

  const agent = createAgent({
    model: process.env.ZERONE_AGENT_MODEL || 'claude-sonnet-4-6',
    agent: { description: 'Session turn limit agent', prompt: { type: 'preset', preset: 'default' }, maxTurns: 3 },
    maxSessionTurns: 2,
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
      // Dynamically override maxSessionTurns per query
      maxSessionTurns: i < 4 ? 2 : 3,
    })
    console.log(`  ${result.text}`)
    console.log(`  Tokens: ${result.usage.input_tokens} in / ${result.usage.output_tokens} out`)
    console.log(`  Session history: ${agent.getMessages().length} messages (full transcript)\n`)
  }

  // Show that full history is preserved in the session
  const fullMessages: Message[] = agent.getMessages()
  console.log('--- Full session transcript (all rounds, never truncated) ---')
  for (const msg of fullMessages) {
    const role = msg.message.role
    const content = msg.message.content
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

  // Demonstrate the utility function directly
  console.log('\n--- truncateToLastNTurns() utility demo ---')
  const sampleMessages: NormalizedMessageParam[] = [
    { role: 'user', content: 'turn 1' },
    { role: 'assistant', content: 'response 1' },
    { role: 'user', content: 'turn 2' },
    { role: 'assistant', content: 'response 2' },
    { role: 'user', content: 'turn 3' },
    { role: 'assistant', content: 'response 3' },
  ]
  const last2 = truncateToLastNTurns(sampleMessages, 2)
  console.log(`  Original: ${sampleMessages.length} messages (3 rounds)`)
  console.log(`  After truncateToLastNTurns(msgs, 2): ${last2.length} messages (last 2 rounds)`)
  console.log(`  First message: ${(last2[0].content as string)}\n`)

  await agent.close()
}

main().catch(console.error)

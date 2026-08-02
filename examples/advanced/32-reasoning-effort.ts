/**
 * Example 32: Reasoning Effort Parameter (effort)
 *
 * Demonstrates how the `effort` parameter controls reasoning depth
 * across different providers. Higher effort produces more thorough
 * responses at the cost of more tokens and latency.
 *
 * The example asks the same complex question at different effort
 * levels and compares response quality, tokens, and duration.
 *
 * Provider mappings:
 * - Anthropic:  output_config.effort (low/medium/high/xhigh/max)
 * - OpenAI:     reasoning_effort   (low/medium/high/max)
 * - Not set:    provider default
 *
 * Run: npx tsx examples/32-reasoning-effort.ts
 */
import { createAgent } from '../../src/index.js'

const QUESTION =
  'A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. ' +
  'How much does the ball cost? Show your reasoning step by step, ' +
  'then verify your answer.'

const EFFORT_LEVELS = ['low', 'medium', 'high'] as const

async function main() {
  console.log('--- Example 32: Reasoning Effort Parameter (effort) ---\n')
  console.log(`Question: ${QUESTION}\n`)

  // --- Part 1: Agent-level default + per-query override ---
  console.log('=== Part 1: Different effort levels (agent default: low) ===\n')

  const agent = createAgent({
    model: process.env.ZERONE_AGENT_MODEL || 'claude-sonnet-4-6',
    agent: { description: 'Reasoning effort low-default agent', prompt: { type: 'preset', preset: 'default' }, maxTurns: 3 },
    effort: 'low', // agent-level default
  })

  for (const level of EFFORT_LEVELS) {
    const t0 = performance.now()

    // Override per-query to test each level
    const result = await agent.prompt(QUESTION, { effort: level })
    const duration = ((performance.now() - t0) / 1000).toFixed(1)

    console.log(`--- effort: "${level}" ---`)
    console.log(`  ${result.text.slice(0, 300)}${result.text.length > 300 ? '...' : ''}`)
    console.log(`  Duration: ${duration}s`)
    console.log(`  Tokens: ${result.usage.input_tokens} in / ${result.usage.output_tokens} out`)
    console.log()
  }

  await agent.close()

  // --- Part 2: No effort (provider default) ---
  console.log('=== Part 2: No effort (provider default) ===\n')

  const defaultAgent = createAgent({
    model: process.env.ZERONE_AGENT_MODEL || 'claude-sonnet-4-6',
    agent: { description: 'Reasoning effort default agent', prompt: { type: 'preset', preset: 'default' }, maxTurns: 3 },
  })

  const t0 = performance.now()
  const result = await defaultAgent.prompt(QUESTION)
  const duration = ((performance.now() - t0) / 1000).toFixed(1)

  console.log(`--- effort: not set (provider default) ---`)
  console.log(`  ${result.text.slice(0, 300)}${result.text.length > 300 ? '...' : ''}`)
  console.log(`  Duration: ${duration}s`)
  console.log(`  Tokens: ${result.usage.input_tokens} in / ${result.usage.output_tokens} out`)

  await defaultAgent.close()
}

main().catch(console.error)

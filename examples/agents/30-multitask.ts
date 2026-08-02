/**
 * Example 30: MultiTask - Parallel Subagents
 *
 * Demonstrates launching multiple Explore subagents in parallel via a single
 * MultiTask tool call. Each subtask streams its events back with task_index /
 * task_description metadata so the parent session can observe per-subtask
 * progress in real time.
 *
 * Prerequisites:
 *   ZERONE_AGENT_API_KEY, ZERONE_AGENT_BASE_URL, ZERONE_AGENT_MODEL
 *
 * Run: npx tsx examples/30-multitask.ts
 */
import { query } from '../../src/index.js'

async function main() {
  const apiKey = process.env.ZERONE_AGENT_API_KEY
  if (!apiKey) {
    console.log('=== Skipped (no ZERONE_AGENT_API_KEY) ===')
    console.log('Set ZERONE_AGENT_API_KEY, ZERONE_AGENT_BASE_URL, ZERONE_AGENT_MODEL to run this example.')
    return
  }

  console.log('=== Example 30: MultiTask - Parallel Subagents ===\n')

  const prompt = [
    'Review the auth and database modules in parallel.',
    'Use the MultiTask tool once with two Explore subtasks:',
    '  - subtask 0 (description "review-auth"): review src/agent.ts for security issues',
    '  - subtask 1 (description "review-db"): review src/snapshot for correctness issues',
    'After MultiTask returns, tell me the high-level findings in one paragraph.',
  ].join('\n')

  let multitaskResultContent = ''
  let multitaskCallCount = 0
  const seenTaskIndices = new Set<number>()

  for await (const message of query({
    prompt,
    options: {
      agent: {
        description: 'Parent orchestrator',
        prompt: { type: 'preset', preset: 'default' },
        allowedTools: ['Read', 'Glob', 'Grep', 'MultiTask'],
      },
      subAgents: {
        reviewer: {
          description: 'Code reviewer for security and maintainability.',
          prompt:
            'You are a code reviewer. Focus on security, correctness, and maintainability. ' +
            'Be concise and list specific issues with file paths and line numbers when possible.',
          allowedTools: ['Read', 'Glob', 'Grep'],
        },
      },
    },
  })) {
    const msg = message as any

    if (msg.type === 'assistant') {
      for (const block of msg.message?.content || []) {
        if (block.type === 'text' && block.text?.trim()) {
          console.log(`[parent] ${block.text}`)
        }
        if (block.type === 'tool_use' && block.name === 'MultiTask') {
          multitaskCallCount++
          console.log(`[parent] → MultiTask called with ${(block.input?.tasks?.length ?? 0)} subtask(s)`)
        }
      }
    }

    if (msg.type === 'subagent') {
      const label = `[subtask ${msg.task_index}: ${msg.task_description}]`
      seenTaskIndices.add(msg.task_index as number)
      const subEvent = msg.event
      if (subEvent?.type === 'assistant') {
        for (const block of subEvent.message?.content || []) {
          if (block.type === 'text' && block.text?.trim()) {
            console.log(`${label} ${block.text}`)
          }
          if (block.type === 'tool_use') {
            console.log(`${label} → ${block.name}`)
          }
        }
      }
    }

    if (msg.type === 'tool_result' && msg.result?.tool_name === 'MultiTask') {
      multitaskResultContent = msg.result.output
      console.log(`[parent] ← MultiTask returned ${(msg.result.output?.length ?? 0)} chars`)
    }

    if (msg.type === 'result') {
      console.log(`\n--- ${msg.subtype} ---`)
    }
  }

  console.log('\n=== Verification ===')
  const assert = (cond: boolean, label: string) => {
    if (cond) {
      console.log(`  ✓ ${label}`)
    } else {
      console.log(`  ✗ ${label}`)
      process.exitCode = 1
    }
  }

  assert(multitaskCallCount >= 1, 'MultiTask tool was called at least once')
  assert(seenTaskIndices.size >= 2, `saw events from at least 2 subtask indices (saw ${seenTaskIndices.size})`)

  if (multitaskResultContent) {
    // Result is plain markdown text (not JSON): summary sections + optional failure appendix
    assert(multitaskResultContent.includes('Aggregated results across 2 completed subtask(s)'), 'summary header present')
    assert(multitaskResultContent.includes('## review-auth'), 'review-auth section present')
    assert(multitaskResultContent.includes('## review-db'), 'review-db section present')
    assert(!multitaskResultContent.includes('Failed subtasks'), 'no subtask failed')
  }
}

main().catch(console.error)

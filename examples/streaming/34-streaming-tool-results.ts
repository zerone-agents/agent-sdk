/**
 * Example 34: Streaming tool_result Events
 *
 * Demonstrates that `tool_result` events now arrive as each tool completes,
 * not batched at the end of `Promise.all`. Three tools with very different
 * execution profiles are dispatched in a single LLM response:
 *
 *   - WebSearch (read-only, parallel batch)        — slow, network-bound
 *   - TodoWrite (mutation, serial queue)            — fast, local write
 *   - Task      (mutation, serial queue, subagent)  — slowest, full LLM round-trips
 *
 * Expected observable behavior:
 *   - tool_result events arrive at distinct timestamps matching each tool's
 *     completion time (NOT batched together)
 *   - tools_complete fires once at the end as the batch boundary signal
 *
 * Prerequisites:
 *   ZERONE_AGENT_API_KEY, ZERONE_AGENT_BASE_URL, ZERONE_AGENT_MODEL
 *
 * Run: npx tsx examples/34-streaming-tool-results.ts
 */
import { createAgent } from '../../src/index.js'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

function assert(condition: any, message: string) {
  if (!condition) {
    console.error(`  ❌ ${message}`)
    process.exitCode = 1
  } else {
    console.log(`  ✅ ${message}`)
  }
}

interface ToolResultRecord {
  toolName: string
  toolUseId: string
  receivedAt: number
}

async function main() {
  const apiKey = process.env.ZERONE_AGENT_API_KEY
  if (!apiKey) {
    console.error('Missing ZERONE_AGENT_API_KEY')
    process.exit(1)
  }

  console.log('=== Example 34: Streaming tool_result Events ===\n')

  const workdir = await mkdtemp(join(tmpdir(), 'streaming-tools-test-'))

  try {
    const subAgents = {
      general: {
        description: 'General-purpose subagent',
        prompt: 'You are a concise assistant. Complete tasks using available tools.',
        allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
      },
    }

    const agent = createAgent({
      model: process.env.ZERONE_AGENT_MODEL || 'claude-sonnet-4-6',
      cwd: workdir,
      apiType: process.env.ZERONE_AGENT_API_TYPE as any,
      apiKey,
      baseURL: process.env.ZERONE_AGENT_BASE_URL,
      subAgents,
      agent: {
        description: 'Streaming tool_result parent',
        prompt: [
          'When asked to perform multiple independent actions, issue ALL tool calls',
          'in a SINGLE response (parallel tool_use blocks). Do NOT call them one',
          'at a time across turns. After all tool_results return, write a one-line',
          'summary and stop.',
        ].join('\n'),
        maxTurns: 8,
        allowedTools: ['TodoWrite', 'WebSearch', 'Task'],
      },
    })

    const prompt = [
      `Do these three things in a single response with three parallel tool calls:`,
      `  1. Use WebSearch to search for "anthropic claude api" and report the top result title`,
      `  2. Use TodoWrite to create a 3-item todo list about "deploy app"`,
      `  3. Use Task (description "count-files") to count files in ${workdir} using ls`,
      `Then write a one-line summary.`,
    ].join('\n')

    console.log(`Prompt:\n${prompt}\n`)

    const toolResults: ToolResultRecord[] = []
    const toolUseIds: string[] = []
    let toolsCompleteAt: number | null = null
    let firstResultAt: number | null = null
    let lastResultAt: number | null = null

    const t0 = Date.now()
    const ts = () => `+${String(Date.now() - t0).padStart(5, '0')}ms`

    for await (const event of agent.query(prompt)) {
      const msg = event as any

      if (msg.type === 'assistant') {
        for (const block of msg.message?.content || []) {
          if (block.type === 'tool_use') {
            toolUseIds.push(block.id)
            console.log(`${ts()} tool_use     ${block.name}  id=${block.id}`)
          }
        }
      } else if (msg.type === 'tool_result') {
        const r = msg.result
        const receivedAt = Date.now()
        if (firstResultAt === null) firstResultAt = receivedAt
        lastResultAt = receivedAt
        toolResults.push({
          toolName: r.tool_name,
          toolUseId: r.tool_use_id,
          receivedAt,
        })
        const preview = String(r.output).slice(0, 60).replace(/\s+/g, ' ')
        console.log(
          `${ts()} tool_result  ${r.tool_name.padEnd(10)} is_error=${r.is_error}  preview="${preview}..."`,
        )
      } else if (msg.type === 'tools_complete') {
        toolsCompleteAt = Date.now()
        console.log(
          `${ts()} tools_complete  count=${msg.tool_results_count}/${msg.tool_use_ids.length}`,
        )
      } else if (msg.type === 'result') {
        console.log(`${ts()} result       subtype=${msg.subtype}`)
      } else if (msg.type === 'user' || msg.type === 'system' || msg.type === 'partial_message') {
        // Suppress noise
      } else if (msg.type === 'subagent') {
        // Subagent events from Task tool — only show meaningful ones (not partial_message noise)
        const inner = msg.event
        if (inner.type !== 'partial_message') {
          console.log(`${ts()} subagent     type=${inner.type} task_index=${msg.task_index}`)
        }
      }
    }

    console.log('\n=== Verification ===\n')

    // 1. All tool_use blocks should have matching tool_result events
    const resultIds = new Set(toolResults.map(r => r.toolUseId))
    assert(
      toolUseIds.length === toolResults.length,
      `tool_result count (${toolResults.length}) matches tool_use count (${toolUseIds.length})`,
    )
    for (const id of toolUseIds) {
      assert(resultIds.has(id), `tool_use_id ${id} has matching tool_result`)
    }

    // 2. tools_complete should have fired
    assert(toolsCompleteAt !== null, 'tools_complete event fired')

    // 3. tools_complete must be the LAST event (no tool_results after it)
    if (toolsCompleteAt !== null && lastResultAt !== null) {
      assert(
        toolsCompleteAt >= lastResultAt,
        `tools_complete (${toolsCompleteAt - t0}ms) fires after last tool_result (${lastResultAt - t0}ms)`,
      )
    }

    // 4. Streaming: distinct timestamps for each tool_result
    if (firstResultAt !== null && lastResultAt !== null) {
      const spread = lastResultAt - firstResultAt
      console.log(`\n  (first→last tool_result spread: ${spread}ms)`)
      // Hailcheck: each tool_result should have a distinct timestamp
      const uniqueTimestamps = new Set(toolResults.map(r => r.receivedAt)).size
      console.log(`  (unique tool_result timestamps: ${uniqueTimestamps}/${toolResults.length})`)
    }

    // 5. Print per-tool arrival times for visual inspection
    console.log('\n  Per-tool arrival times:')
    for (const r of toolResults) {
      console.log(`    ${r.toolName.padEnd(10)} +${String(r.receivedAt - t0).padStart(5, '0')}ms`)
    }

    console.log('\nDone.')
  } finally {
    await rm(workdir, { recursive: true, force: true })
  }
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})

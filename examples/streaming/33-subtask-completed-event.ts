/**
 * Example 33: subtask_completed Event Stream
 *
 * Demonstrates the real-time `subtask_completed` event emitted by MultiTask
 * and Task tools the instant each subtask's IIFE resolves. Unlike the final
 * aggregated `tool_result`, this event fires per-subtask as soon as the
 * parent-level semantic state (status / output / error / toolsUsed /
 * maxTurnsHit) is known — letting UIs update per-subtask cards immediately
 * instead of waiting for Promise.allSettled.
 *
 * Prerequisites:
 *   ZERONE_AGENT_API_KEY, ZERONE_AGENT_BASE_URL, ZERONE_AGENT_MODEL
 *
 * Run: npx tsx examples/33-subtask-completed-event.ts
 */
import { createAgent } from '../../src/index.js'
import { mkdtemp, rm, writeFile } from 'fs/promises'
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

interface CapturedSubtaskCompleted {
  parentToolUseId: string
  sessionId?: string
  taskIndex?: number
  taskDescription?: string
  status: string
  output: string | null
  error: string | null
  toolsUsed: string[]
  maxTurnsHit: boolean
}

function captureSubtaskCompleted(events: CapturedSubtaskCompleted[], msg: any) {
  if (msg.type !== 'subagent') return
  const inner = msg.event
  if (!inner || inner.type !== 'subtask_completed') return
  events.push({
    parentToolUseId: msg.parent_tool_use_id ?? '',
    sessionId: msg.session_id,
    taskIndex: msg.task_index,
    taskDescription: msg.task_description,
    status: inner.status,
    output: inner.output,
    error: inner.error,
    toolsUsed: inner.toolsUsed,
    maxTurnsHit: inner.maxTurnsHit,
  })
  // Live log
  const idx = msg.task_index ?? 0
  const desc = msg.task_description ?? '(no description)'
  console.log(`  ⚡ subtask_completed [idx=${idx} desc="${desc}"] status=${inner.status} maxTurnsHit=${inner.maxTurnsHit} tools=[${inner.toolsUsed.join(',')}]`)
  if (inner.output) {
    const preview = inner.output.slice(0, 120).replace(/\n/g, ' ')
    console.log(`     output: ${preview}${inner.output.length > 120 ? '…' : ''}`)
  }
  if (inner.error) {
    console.log(`     error: ${inner.error.slice(0, 200)}`)
  }
}

async function main() {
  const apiKey = process.env.ZERONE_AGENT_API_KEY
  if (!apiKey) {
    console.log('=== Skipped (no ZERONE_AGENT_API_KEY) ===')
    console.log('Set ZERONE_AGENT_API_KEY, ZERONE_AGENT_BASE_URL, ZERONE_AGENT_MODEL to run this example.')
    return
  }

  console.log('=== Example 33: subtask_completed Event Stream ===\n')

  const workdir = await mkdtemp(join(tmpdir(), 'subtask-completed-test-'))

  // Set up a small sample project for subagents to explore
  await writeFile(join(workdir, 'math.ts'), [
    'export function add(a: number, b: number): number {',
    '  return a + b',
    '}',
    '',
    'export function subtract(a: number, b: number): number {',
    '  return a - b',
    '}',
    '',
    'export const VERSION = "1.0.0"',
    '',
  ].join('\n'))

  await writeFile(join(workdir, 'README.md'), [
    '# Math Utils',
    '',
    'A simple math utility library.',
    'Current version: 1.0.0',
    '',
  ].join('\n'))

  const sharedAgents = {
    general: {
      description: 'General purpose agent with full toolset',
      prompt: 'You are a helpful coding assistant. Complete tasks using the available tools. Be concise.',
      allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
    },
    researcher: {
      description: 'Read-only research agent',
      prompt: 'You are a code research assistant. Find information and report findings concisely.',
      allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
    },
  }

  // ---------------------------------------------------------------
  // Test 1: MultiTask emits subtask_completed per subtask
  // ---------------------------------------------------------------
  console.log('--- Test 1: MultiTask parallel subtasks ---\n')

  const agent1 = createAgent({
    model: process.env.ZERONE_AGENT_MODEL || 'claude-sonnet-4-6',
    agentId: 'general',
    subAgents: sharedAgents,
    // Restrict parent's toolset to force delegation via MultiTask
    // (otherwise some models just Read the file directly and skip MultiTask)
    agent: {
      description: 'MultiTask subtask_completed parent',
      prompt: { type: 'preset', preset: 'default' },
      maxTurns: 10,
      allowedTools: ['MultiTask'],
    },
    cwd: workdir,
    apiType: process.env.ZERONE_AGENT_API_TYPE as any,
    apiKey,
    baseURL: process.env.ZERONE_AGENT_BASE_URL,
  })

  const multitaskPrompt = [
    'Use the MultiTask tool ONCE with exactly two subtasks:',
    '  - subtask 0 (description "find-functions"): use Read to inspect math.ts and list all exported functions',
    '  - subtask 1 (description "find-version"): use Read to inspect README.md and report the version',
    'After MultiTask returns, give me a one-line summary.',
  ].join('\n')

  console.log(`Prompt: ${multitaskPrompt.slice(0, 120)}...\n`)

  const multitaskCompleted: CapturedSubtaskCompleted[] = []
  let multitaskParentToolUseId = ''

  for await (const event of agent1.query(multitaskPrompt)) {
    const msg = event as any

    // Track the MultiTask tool_use id so we can verify per-subtask events reference it
    if (msg.type === 'assistant') {
      for (const block of msg.message?.content || []) {
        if (block.type === 'tool_use' && block.name === 'MultiTask') {
          multitaskParentToolUseId = block.id
          console.log(`  → MultiTask invoked (tool_use_id=${block.id}) with ${block.input?.tasks?.length ?? 0} subtasks`)
        }
      }
    }

    captureSubtaskCompleted(multitaskCompleted, msg)

    if (msg.type === 'assistant') {
      for (const block of msg.message?.content || []) {
        if (block.type === 'text' && block.text?.trim()) {
          console.log(`  [parent] ${block.text.slice(0, 200)}`)
        }
      }
    }
  }

  console.log('\n--- Test 1 Verification ---')
  assert(multitaskCompleted.length === 2, `captured exactly 2 subtask_completed events (got ${multitaskCompleted.length})`)

  if (multitaskCompleted.length > 0) {
    // Sort by task_index for deterministic assertions (concurrent subtasks may arrive in any order)
    multitaskCompleted.sort((a, b) => (a.taskIndex ?? 0) - (b.taskIndex ?? 0))

    assert(
      multitaskCompleted.every(e => e.status === 'completed'),
      `all subtasks report status=completed (got: ${multitaskCompleted.map(e => e.status).join(', ')})`,
    )
    assert(
      multitaskCompleted.every(e => typeof e.output === 'string' && e.output.length > 0),
      'all subtasks have non-empty output',
    )
    assert(
      multitaskCompleted.every(e => e.error === null),
      'all subtasks have error=null',
    )
    assert(
      multitaskCompleted.every(e => Array.isArray(e.toolsUsed)),
      'all subtasks have toolsUsed array (may be empty)',
    )
    assert(
      multitaskCompleted.every(e => e.maxTurnsHit === false),
      'no subtask hit maxTurns',
    )
    assert(
      multitaskCompleted.every(e => typeof e.sessionId === 'string' && e.sessionId.length > 0),
      'every event carries a sessionId',
    )
    // parent_tool_use_id should match the MultiTask tool_use block id
    assert(
      multitaskParentToolUseId.length > 0 && multitaskCompleted.every(e => e.parentToolUseId === multitaskParentToolUseId),
      `all subtask_completed events carry the parent MultiTask tool_use_id`,
    )
    // task_index values should cover 0 and 1
    const indices = multitaskCompleted.map(e => e.taskIndex).sort()
    assert(
      indices.length === 2 && indices[0] === 0 && indices[1] === 1,
      `task_index values are {0,1} (got: ${JSON.stringify(indices)})`,
    )
  }

  await agent1.close()

  // ---------------------------------------------------------------
  // Test 2: Task emits exactly one subtask_completed
  // ---------------------------------------------------------------
  console.log('\n--- Test 2: Task single subtask ---\n')

  const agent2 = createAgent({
    model: process.env.ZERONE_AGENT_MODEL || 'claude-sonnet-4-6',
    agentId: 'general',
    subAgents: sharedAgents,
    // Restrict parent's toolset to force delegation via Task
    agent: {
      description: 'Task subtask_completed parent',
      prompt: { type: 'preset', preset: 'default' },
      maxTurns: 10,
      allowedTools: ['Task'],
    },
    cwd: workdir,
    apiType: process.env.ZERONE_AGENT_API_TYPE as any,
    apiKey,
    baseURL: process.env.ZERONE_AGENT_BASE_URL,
  })

  const taskPrompt = [
    'Use the Task tool ONCE with subagent_type "Explore" to:',
    '  1. Read math.ts and report which functions are exported',
    'After the Task completes, give me a one-line summary.',
  ].join('\n')

  console.log(`Prompt: ${taskPrompt.slice(0, 120)}...\n`)

  const taskCompleted: CapturedSubtaskCompleted[] = []
  let taskParentToolUseId = ''
  let sawSubagentAssistantWithEmptyParentId = false

  for await (const event of agent2.query(taskPrompt)) {
    const msg = event as any

    if (msg.type === 'assistant') {
      for (const block of msg.message?.content || []) {
        if (block.type === 'tool_use' && block.name === 'Task') {
          taskParentToolUseId = block.id
          console.log(`  → Task invoked (tool_use_id=${block.id})`)
        }
      }
    }

    // Regression check for the pre-existing parent_tool_use_id bug we fixed in this PR
    if (msg.type === 'subagent') {
      if (msg.parent_tool_use_id === '' && msg.event?.type === 'assistant') {
        sawSubagentAssistantWithEmptyParentId = true
      }
    }

    captureSubtaskCompleted(taskCompleted, msg)

    if (msg.type === 'assistant') {
      for (const block of msg.message?.content || []) {
        if (block.type === 'text' && block.text?.trim()) {
          console.log(`  [parent] ${block.text.slice(0, 200)}`)
        }
      }
    }
  }

  console.log('\n--- Test 2 Verification ---')
  assert(taskCompleted.length === 1, `captured exactly 1 subtask_completed event (got ${taskCompleted.length})`)

  if (taskCompleted.length === 1) {
    const e = taskCompleted[0]
    assert(e.status === 'completed', `subtask status=completed (got ${e.status})`)
    assert(typeof e.output === 'string' && e.output.length > 0, 'subtask has non-empty output')
    assert(e.error === null, 'subtask error=null')
    assert(e.maxTurnsHit === false, 'subtask did not hit maxTurns')
    assert(typeof e.sessionId === 'string' && e.sessionId.length > 0, 'subtask event carries sessionId')
    assert(e.taskIndex === 0, `subtask task_index=0 (got ${e.taskIndex})`)

    // parent_tool_use_id regression check (was '' before this PR)
    assert(
      taskParentToolUseId.length > 0 && e.parentToolUseId === taskParentToolUseId,
      `subtask_completed parent_tool_use_id matches the Task tool_use_id (regression for '' bug)`,
    )
  }

  // Regression: pre-existing propagated events should also have correct parent_tool_use_id
  assert(
    !sawSubagentAssistantWithEmptyParentId,
    'no propagated subagent event carried an empty parent_tool_use_id (regression check)',
  )

  await agent2.close()

  // Cleanup
  await rm(workdir, { recursive: true, force: true })

  console.log('\n=== All Tests Done ===')
}

main().catch((err) => {
  console.error('Example failed:', err)
  process.exit(1)
})

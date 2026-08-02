/**
 * Example 29: Task Tool Modes (Explore vs General)
 *
 * Demonstrates the redesigned Task tool with actual LLM execution:
 * - General mode: subagent inherits full toolset, can read AND write files
 * - Explore mode: subagent restricted to read-only tools + Bash, cannot modify files
 *
 * Prerequisites:
 *   ZERONE_AGENT_API_KEY, ZERONE_AGENT_BASE_URL, ZERONE_AGENT_MODEL
 *
 * Run: npx tsx examples/29-task-tool-modes.ts
 */

import { createAgent } from '../../src/index.js'
import { mkdtemp, rm, readFile, writeFile } from 'fs/promises'
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

async function main() {
  const apiKey = process.env.ZERONE_AGENT_API_KEY
  if (!apiKey) {
    console.log('=== Skipped (no ZERONE_AGENT_API_KEY) ===')
    console.log('Set ZERONE_AGENT_API_KEY, ZERONE_AGENT_BASE_URL, ZERONE_AGENT_MODEL to run this example.')
    return
  }

  console.log('=== Example 29: Task Tool Modes (Explore vs General) ===\n')

  const workdir = await mkdtemp(join(tmpdir(), 'task-modes-test-'))

  // Create a sample project for subagents to explore
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

  // Register agents that subagents can inherit
  const sharedAgents = {
    general: {
      description: 'General purpose agent with full toolset',
      prompt: 'You are a helpful coding assistant. Complete tasks using the available tools.',
      allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
    },
    researcher: {
      description: 'Read-only research agent',
      prompt: 'You are a code research assistant. Find information and report findings.',
      allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
    },
  }

  // ---------------------------------------------------------------
  // Test 1: General mode — subagent should be able to modify files
  // ---------------------------------------------------------------
  console.log('--- Test 1: General mode (full capabilities) ---\n')

  const agent = createAgent({
    model: process.env.ZERONE_AGENT_MODEL || 'claude-sonnet-4-6',
    agentId: 'general',
    subAgents: sharedAgents,
    agent: { description: 'Task-tool-modes general test agent', prompt: { type: 'preset', preset: 'default' }, maxTurns: 10 },
    cwd: workdir,
    apiType: process.env.ZERONE_AGENT_API_TYPE as any,
    apiKey,
    baseURL: process.env.ZERONE_AGENT_BASE_URL,
  })

  const generalPrompt = [
    'Use the Task tool with subagent_type "General" to do the following:',
    '1. Read math.ts and find the VERSION constant',
    '2. Update the VERSION from "1.0.0" to "2.0.0" in math.ts',
    '',
    'After the Task completes, tell me the result.',
  ].join('\n')

  console.log(`Prompt: ${generalPrompt.slice(0, 120)}...\n`)

  let generalTaskResult = ''
  let generalTaskCount = 0

  for await (const event of agent.query(generalPrompt)) {
    if (event.type === 'tool_result' && event.result.tool_name === 'Task') {
      generalTaskCount++
      generalTaskResult = event.result.output
      console.log(`  [Task output] ${event.result.output.slice(0, 200)}`)
    }

    if (event.type === 'subagent') {
      const subEvent = (event as any).event
      if (subEvent?.type === 'tool_result') {
        console.log(`  [Subagent tool] ${subEvent.result?.tool_name}: ${subEvent.result?.output?.slice(0, 100)}`)
      }
    }

    if (event.type === 'assistant' && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === 'text' && block.text.trim()) {
          console.log(`\n[Assistant] ${block.text.slice(0, 300)}`)
        }
      }
    }
  }

  // Verify: file should be modified
  const mathAfterGeneral = await readFile(join(workdir, 'math.ts'), 'utf-8')
  console.log('\n--- Test 1 Verification ---')
  assert(generalTaskCount >= 1, 'Task tool was called at least once')
  assert(mathAfterGeneral.includes('2.0.0'), 'math.ts was updated to 2.0.0 by General subagent')
  assert(!mathAfterGeneral.includes('"1.0.0"'), 'old version string is gone')

  await agent.close()

  // ---------------------------------------------------------------
  // Test 2: Explore mode — subagent should NOT modify files
  // ---------------------------------------------------------------
  console.log('\n--- Test 2: Explore mode (read-only) ---\n')

  // Reset the file
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

  const agent2 = createAgent({
    model: process.env.ZERONE_AGENT_MODEL || 'claude-sonnet-4-6',
    agentId: 'general',
    subAgents: sharedAgents,
    agent: { description: 'Task-tool-modes explore test agent', prompt: { type: 'preset', preset: 'default' }, maxTurns: 10 },
    cwd: workdir,
    apiType: process.env.ZERONE_AGENT_API_TYPE as any,
    apiKey,
    baseURL: process.env.ZERONE_AGENT_BASE_URL,
  })

  const explorePrompt = [
    'Use the Task tool with subagent_type "Explore" to do the following:',
    '1. Read math.ts and find what functions are defined',
    '2. Report the VERSION value',
    '',
    'After the Task completes, tell me what the subagent found.',
  ].join('\n')

  console.log(`Prompt: ${explorePrompt.slice(0, 120)}...\n`)

  let exploreTaskResult = ''
  let exploreTaskCount = 0
  const subagentToolNames: string[] = []

  for await (const event of agent2.query(explorePrompt)) {
    if (event.type === 'tool_result' && event.result.tool_name === 'Task') {
      exploreTaskCount++
      exploreTaskResult = event.result.output
      console.log(`  [Task output] ${event.result.output.slice(0, 200)}`)
    }

    if (event.type === 'subagent') {
      const subEvent = (event as any).event
      if (subEvent?.type === 'tool_result') {
        const toolName = subEvent.result?.tool_name
        if (toolName) {
          subagentToolNames.push(toolName)
          console.log(`  [Subagent used tool] ${toolName}`)
        }
      }
    }

    if (event.type === 'assistant' && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === 'text' && block.text.trim()) {
          console.log(`\n[Assistant] ${block.text.slice(0, 300)}`)
        }
      }
    }
  }

  // Verify: file should NOT be modified, subagent should only use read-only tools
  const mathAfterExplore = await readFile(join(workdir, 'math.ts'), 'utf-8')
  console.log('\n--- Test 2 Verification ---')
  assert(exploreTaskCount >= 1, 'Task tool was called at least once')
  assert(mathAfterExplore.includes('"1.0.0"'), 'math.ts was NOT modified by Explore subagent')

  // Check that no write/edit tools were used by the subagent
  const mutationTools = subagentToolNames.filter(t => ['Write', 'Edit', 'NotebookEdit'].includes(t))
  assert(mutationTools.length === 0, `Explore subagent did not use mutation tools (found: ${mutationTools.join(', ') || 'none'})`)

  if (exploreTaskResult) {
    assert(exploreTaskResult.includes('add') || exploreTaskResult.includes('subtract'), 'subagent found the functions')
    assert(exploreTaskResult.includes('1.0.0') || exploreTaskResult.includes('VERSION'), 'subagent reported the version')
  }

  await agent2.close()

  // ---------------------------------------------------------------
  // Test 3: subagent_name — use a different registered agent
  // ---------------------------------------------------------------
  console.log('\n--- Test 3: subagent_name override ---\n')

  const agent3 = createAgent({
    model: process.env.ZERONE_AGENT_MODEL || 'claude-sonnet-4-6',
    agentId: 'general',
    subAgents: sharedAgents,
    agent: { description: 'Task-tool-modes named-subagent test agent', prompt: { type: 'preset', preset: 'default' }, maxTurns: 10 },
    cwd: workdir,
    apiType: process.env.ZERONE_AGENT_API_TYPE as any,
    apiKey,
    baseURL: process.env.ZERONE_AGENT_BASE_URL,
  })

  const namedPrompt = [
    'Use the Task tool with subagent_type "General" and subagent_name "researcher" to:',
    '1. Search the codebase for all exported functions',
    '2. Report the file names and function names found',
    '',
    'Tell me the results.',
  ].join('\n')

  console.log(`Prompt: ${namedPrompt.slice(0, 120)}...\n`)

  let namedTaskResult = ''

  for await (const event of agent3.query(namedPrompt)) {
    if (event.type === 'tool_result' && event.result.tool_name === 'Task') {
      namedTaskResult = event.result.output
      console.log(`  [Task output] ${event.result.output.slice(0, 300)}`)
    }

    if (event.type === 'assistant' && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === 'text' && block.text.trim()) {
          console.log(`\n[Assistant] ${block.text.slice(0, 300)}`)
        }
      }
    }
  }

  console.log('\n--- Test 3 Verification ---')
  assert(namedTaskResult.length > 0, 'researcher subagent produced output')
  assert(namedTaskResult.includes('add') || namedTaskResult.includes('subtract'), 'researcher found exported functions')

  await agent3.close()

  // Cleanup
  await rm(workdir, { recursive: true, force: true })

  console.log('\n=== All Tests Done ===')
}

main().catch(console.error)

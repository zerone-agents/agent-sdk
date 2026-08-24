/**
 * Example 39: Cron Runtime — SDK scheduling with filesystem persistence
 *
 * End-to-end demonstration of the SDK cron runtime (issue #42):
 *   1. createDefaultCronService({ dataDir, resolveAgent }) — filesystem
 *      adapters + single-writer runtime.lock under <dataDir>/cron/
 *   2. AgentOptions.cronService — CronCreate/CronDelete/CronList read the
 *      SAME CronService the host uses from per-agent toolServices (ADR 0005)
 *   3. Ask the LLM to schedule a recurring task — the model resolves the
 *      deferred tool first: FindTool(select:CronCreate) -> CronCreate
 *   4. service.runNow(taskId) — manual trigger through the coordinator and
 *      DefaultAgentCronExecutor (fresh agent per fire, execution state
 *      persisted to executions.jsonl)
 *   5. service.stop() — drain in-flight executions, release runtime.lock
 *
 * Env:
 *   ZERONE_AGENT_API_KEY   required (see .env.example)
 *   ZERONE_AGENT_MODEL     optional model override
 *   ZERONE_AGENT_BASE_URL  optional custom endpoint (e.g. Anthropic-compat proxy)
 *   ZERONE_AGENT_API_TYPE  optional api type override (e.g. anthropic-messages)
 *
 * Run: npx tsx examples/tools/39-cron-runtime.ts
 */
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createAgent } from '../../src/index.js'
import { createDefaultCronService } from '../../src/cron/node/index.js'
import type { AgentOptions } from '../../src/types.js'
import type { CronService } from '../../src/cron/service.js'

const MODEL = process.env.ZERONE_AGENT_MODEL || 'claude-sonnet-4-6'

/** Agent definition used both for the interactive query and for cron fires. */
function agentOptions(cron?: CronService): AgentOptions {
  return {
    model: MODEL,
    // ADR 0005: cron tools resolve the service from per-agent toolServices.
    ...(cron ? { cronService: cron } : {}),
    agent: {
      description: 'Cron runtime demo agent',
      prompt: { type: 'preset', preset: 'default' },
      maxTurns: 10,
    },
  }
}

async function main() {
  if (!process.env.ZERONE_AGENT_API_KEY) {
    console.error(
      'Missing ZERONE_AGENT_API_KEY. Copy .env.example to .env (or export it) and re-run.',
    )
    process.exit(1)
  }

  console.log('--- Example 39: Cron Runtime ---\n')

  // --- 1. Default cron runtime: filesystem persistence + directory lock ----
  // dataDir omitted would default to ~/.agents (files under ~/.agents/cron/);
  // here we use a throwaway dir to keep the demo side-effect-free.
  const dataDir = await mkdtemp(path.join(tmpdir(), 'cron-example-'))
  const cronDir = path.join(dataDir, 'cron')
  const service = createDefaultCronService({
    dataDir,
    // Resolved FRESH on every fire — credentials/models never live in the task.
    resolveAgent: async () => agentOptions(),
  })
  await service.start()
  console.log(`[1] cron runtime started: ${cronDir}`)

  // --- 2. Wire the SDK tools to the same service the host uses -------------
  console.log('[2] AgentOptions.cronService — cron tools share the host CronService\n')

  // --- 3. Let the LLM schedule a task (deferred: FindTool -> CronCreate) ----
  const agent = createAgent(agentOptions(service))
  const userPrompt =
    'Schedule a recurring task using the CronCreate tool: every minute, ' +
    'prompt: "Run `git log --oneline -1` in the current directory and report the result in one sentence." ' +
    'Do NOT run the task yourself — only create the schedule.'

  console.log('=== USER REQUEST ===')
  console.log(userPrompt + '\n')

  for await (const event of agent.query(userPrompt)) {
    const msg = event as any

    if (msg.type === 'assistant') {
      for (const block of msg.message?.content || []) {
        if (block.type === 'tool_use') {
          console.log(`[Tool Call] ${block.name}: ${JSON.stringify(block.input)}`)
        }
      }
    }

    if (msg.type === 'tool_result') {
      const output = String(msg.result?.output ?? '').slice(0, 160)
      console.log(`[Tool Result] ${msg.result?.tool_name}: ${output}`)
    }
  }

  const tasks = await service.list()
  console.log(`\n[3] service.list() -> ${tasks.length} task(s)`)
  for (const t of tasks) {
    console.log(`    ${t.id}  cron="${t.cron}"  prompt="${t.prompt.slice(0, 60)}..."`)
  }
  if (tasks.length === 0) throw new Error('LLM did not create a cron task')

  const onDisk = await readdir(cronDir)
  console.log(`    files on disk: ${onDisk.join(', ')}`)

  // --- 4. Manual trigger: real execution through the coordinator -----------
  const task = tasks[0]!
  console.log(`\n[4] service.runNow(${task.id}) — executing via a fresh agent ...`)
  const execution = await service.runNow(task.id)
  console.log(`    status:   ${execution.status} (trigger: ${execution.trigger})`)
  console.log(`    output:   ${(execution.output ?? '').slice(0, 200)}`)

  const logText = await readFile(path.join(cronDir, 'executions.jsonl'), 'utf8')
  const lastRecord = JSON.parse(logText.trimEnd().split('\n').pop()!)
  console.log(`    persisted: executions.jsonl last record status=${lastRecord.execution.status}`)

  // --- 5. Drain + release the runtime lock ---------------------------------
  await service.stop()
  console.log('\n[5] service.stop() — drained, runtime.lock released')

  await rm(dataDir, { recursive: true, force: true })
  console.log(`    cleaned up ${dataDir}`)
  console.log('\n--- Example 39 complete ---')
}

main().catch(console.error)

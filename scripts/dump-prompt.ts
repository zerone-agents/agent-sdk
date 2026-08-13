/**
 * Temporary debug script: dump the full system prompt with all blocks active.
 * Run with: npx tsx scripts/dump-prompt.ts
 */
import { buildSystemPrompt } from '../src/engine/prompt-builder.js'
import { SkillRegistry } from '../src/skills/registry.js'
import { mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

async function main() {
  // Set up a temp cwd with a real git repo so <environment> reports "yes"
  const cwd = await mkdtemp(join(tmpdir(), 'dump-'))
  await execFileAsync('git', ['init'], { cwd })

  // Fake subagents: one matches agentId (self), one is a sibling
  const subAgents = {
    'claude-code': {
      description: 'I am Zerone Code, an interactive software engineering agent powered by the Yi-One and the Zerone Agent SDK.',
      prompt: 'You are Zerone Code.',
    },
    'code-reviewer': {
      description: 'Reviews code for bugs and style.',
      prompt: 'You are a code reviewer.',
    },
  }

  // Build a skill registry with a couple of skills
  const skillRegistry = new SkillRegistry()
  skillRegistry.register({
    name: 'commit',
    description: 'Create git commits following conventions',
    getPrompt: async () => [],
  }, 'project')
  skillRegistry.register({
    name: 'brainstorming',
    description: 'Use before any creative work to explore intent',
    getPrompt: async () => [],
  }, 'user')

  const config = {
    env: {
      cwd,
      model: 'glm-5.2',
      provider: {} as any,
      tools: [],
      skills: [],
      settingSources: ['user', 'project'] as const,
      customTools: [],
      skillRegistry,
      mcpTools: [],
      toolEnv: {},
      toolEnvInherit: {},
    },
    resolved: {
      definition: { prompt: 'You are Zerone Code, an interactive software engineering agent.', allowedTools: [], availableSkills: [] },
      tools: [
        { name: 'Read', call: async () => ({}) } as any,
        { name: 'Task', call: async () => ({}) } as any,
        { name: 'MultiTask', call: async () => ({}) } as any,
        { name: 'Skill', call: async () => ({}) } as any,
        { name: 'FindTool', call: async () => ({}) } as any,
      ],
      deferredTools: [
        {
          name: 'CronList',
          description: 'List all scheduled cron tasks',
          shortDescription: 'List scheduled tasks',
          call: async () => ({}),
        } as any,
        {
          name: 'MemorySearch',
          description: 'Search memory records',
          shortDescription: 'Search memory',
          call: async () => ({}),
        } as any,
      ],
      skills: skillRegistry.getUserInvocable(),
    },
    subAgents,
    agentId: 'claude-code',
    maxTurns: 10,
    canUseTool: async () => true,
    includePartialMessages: false,
  } as any

  const prompt = await buildSystemPrompt(config)
  const outPath = join(process.cwd(), 'prompt-dump.txt')
  await writeFile(outPath, prompt, 'utf-8')
  process.stdout.write(`\nPrompt written to: ${outPath}\n`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

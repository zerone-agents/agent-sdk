/**
 * Example 37: Disable Skill Injection by Filtering Out the Skill Tool
 *
 * Demonstrates the cross-validation guard in resolveAgent: when
 * allowedTools/disallowedTools exclude the Skill tool, the system prompt
 * and init event both stop advertising skills the model cannot invoke.
 *
 * Runs a real end-to-end LLM call so you can see:
 *   - init.skills and init.system_prompt (the SDK contract)
 *   - the model's actual response (proving the agent still works without
 *     the Skill tool, and doesn't get confused by phantom guidance)
 *
 * Run: npx tsx examples/advanced/37-disable-skill-injection.ts
 */
import { createAgent, registerSkill } from '../../src/index.js'

interface InitSnapshot {
  systemPrompt: string
  skills: string[]
  hasSkillsBlock: boolean
  hasAvailableSkillsXml: boolean
}

async function runAgent(label: string, agent: ReturnType<typeof createAgent>): Promise<{ init: InitSnapshot; response: string }> {
  let init: InitSnapshot | null = null
  let response = ''
  for await (const msg of agent.query('Say hello in one short sentence.')) {
    if (!init && msg.type === 'system' && (msg as any).subtype === 'init') {
      const sp: string = (msg as any).system_prompt
      init = {
        systemPrompt: sp,
        skills: (msg as any).skills as string[],
        hasSkillsBlock: sp.includes('## Skills'),
        hasAvailableSkillsXml: sp.includes('<available_skills>'),
      }
    } else if (msg.type === 'assistant') {
      const fragments = ((msg as any).message.content as any[])
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
      if (fragments.length) response = fragments.join('')
    }
  }
  if (!init) throw new Error(`${label}: init event not emitted`)
  return { init, response }
}

async function main() {
  console.log('--- Example 37: Disable Skill Injection ---\n')

  if (!process.env.ZERONE_AGENT_API_KEY) {
    console.error('Error: ZERONE_AGENT_API_KEY is required for this example.')
    console.error('Export ZERONE_AGENT_API_KEY (and optionally BASE_URL/MODEL/API_TYPE) and re-run.')
    process.exit(1)
  }

  // Register a skill in the default registry so both agents can see it
  registerSkill({
    name: 'demo-skill',
    description: 'A demonstration skill that should only appear when Skill tool is available',
    getPrompt: async () => [{ role: 'user', content: 'Demo skill loaded' }],
  })

  // Agent A: default config — Skill tool available, skills advertised
  const agentA = createAgent({
    model: process.env.ZERONE_AGENT_MODEL || 'claude-sonnet-4-6',
    agent: {
      description: 'Default agent with Skill tool',
      prompt: { type: 'preset', preset: 'default' },
      maxTurns: 1,
    },
  })

  // Agent B: Skill tool filtered out via disallowedTools
  const agentB = createAgent({
    model: process.env.ZERONE_AGENT_MODEL || 'claude-sonnet-4-6',
    agent: {
      description: 'Agent without Skill tool',
      prompt: { type: 'preset', preset: 'default' },
      disallowedTools: ['Skill'],
      maxTurns: 1,
    },
  })

  console.log('=== Agent A (default — Skill tool available) ===')
  const a = await runAgent('A', agentA)
  console.log('init.skills:                    ', a.init.skills)
  console.log('system_prompt has ## Skills:    ', a.init.hasSkillsBlock)
  console.log('system_prompt has <available_skills>:', a.init.hasAvailableSkillsXml)
  console.log('model response:                 ', JSON.stringify(a.response))

  console.log('\n=== Agent B (disallowedTools: [Skill]) ===')
  const b = await runAgent('B', agentB)
  console.log('init.skills:                    ', b.init.skills)
  console.log('system_prompt has ## Skills:    ', b.init.hasSkillsBlock)
  console.log('system_prompt has <available_skills>:', b.init.hasAvailableSkillsXml)
  console.log('model response:                 ', JSON.stringify(b.response))

  console.log('\n--- Summary ---')
  console.log(`Agent A advertises skills: ${a.init.skills.length > 0}`)
  console.log(`Agent B advertises skills: ${b.init.skills.length > 0}`)
  console.log(`Agent B completed turn without Skill tool: ${b.response.length > 0}`)
}

main().catch((err) => {
  console.error('Example failed:', err)
  process.exit(1)
})

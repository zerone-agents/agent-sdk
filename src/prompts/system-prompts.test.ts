import { describe, expect, it } from 'vitest'
import { SYSTEM_PROMPTS } from './system-prompts.js'

describe('skill guidance', () => {
  it('requires loading clearly matched skills before proceeding', () => {
    expect(SYSTEM_PROMPTS.skill_guidance).toBe(`## Skills

Before beginning a task, you MUST review <available_skills>.

If a skill clearly matches the user's request, you MUST invoke the Skill tool to load it before proceeding. Skills contain task-specific instructions, workflows, and resources; do not bypass a clearly relevant skill by relying solely on general knowledge.

If multiple skills clearly match, load the smallest set that fully covers the task. Proceed without the Skill tool only when no listed skill clearly applies.`)
  })
})

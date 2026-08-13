import { describe, expect, it } from 'vitest'
import { SYSTEM_PROMPTS } from './system-prompts.js'

describe('skill guidance', () => {
  it('requires loading clearly matched skills before proceeding', () => {
    expect(SYSTEM_PROMPTS.skill_guidance).toBe(`Before beginning a task, you MUST review <available_skills>.
If a skill clearly matches the user's request, you MUST invoke the Skill tool to load it before proceeding. Skills contain task-specific instructions, workflows, and resources; do not bypass a clearly relevant skill by relying solely on general knowledge.
If multiple skills clearly match, load the smallest set that fully covers the task. Proceed without the Skill tool only when no listed skill clearly applies.`)
  })
})

describe('subagent guidance', () => {
  it('explains when and how to delegate to subagents', () => {
    expect(SYSTEM_PROMPTS.subagent_guidance).toBe(`When facing complex multi-step tasks, consider delegating to a subagent. Each subagent runs with its own isolated context window and conversation history, isolated from the main conversation.
Use the Task tool to launch a single subagent for self-contained work, or the MultiTask tool to run several independent subagents in parallel. Delegate research, code review, or implementation tasks that benefit from focused, autonomous execution.
Do not use subagents for trivial 1-2 step tasks that you can handle directly. Each subagent invocation has overhead — only delegate when the task complexity justifies it.`)
  })
})

describe('findtool guidance', () => {
  it('explains lazy-load and FindTool-before-invoke contract', () => {
    expect(SYSTEM_PROMPTS.findtool_guidance).toBe(`Tool schemas are loaded lazily to conserve context. The <deferred_tool> entries below expose names and one-line descriptions only — their input schemas are not yet in your context.
Before invoking a deferred tool, use the FindTool tool to load its schema; calling an unloaded tool will fail.
Load promptly when the task clearly requires it, but avoid speculative loads — each schema consumes context budget.`)
  })
})

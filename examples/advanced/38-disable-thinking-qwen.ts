/**
 * Example 38: Disable Thinking on qwen3.8-flash (thinking: {type: 'disabled'})
 *
 * Qwen3.8 models think BY DEFAULT (reasoning / thinking blocks appear in
 * every response). Since SDK v4.2.1 the `thinking: { type: 'disabled' }`
 * config is honored end-to-end on BOTH Alibaba Bailian API shapes:
 *
 *   API shape               | What the SDK sends
 *   ------------------------+--------------------------------------------------
 *   anthropic-messages      | native `thinking: {type: 'disabled'}` field
 *   openai-completions      | dual-send `enable_thinking: false` — top-level
 *                           | (Bailian) + chat_template_kwargs (vLLM compat)
 *
 * In both parts below, the response must contain NO thinking block —
 * that is the observable proof that "disable thinking" took effect.
 * (Before v4.2.1 the config was silently dropped at three layers and
 * qwen3.8 kept thinking — see issue #166.)
 *
 * Verified on Alibaba Bailian (token-plan, qwen3.8-flash, both API shapes,
 * 0 thinking blocks each — see the issue #166 end-to-end retest comment).
 * The vLLM half of the dual-send relies on the standard tolerance
 * convention (endpoints ignore unknown fields) — not separately verified.
 *
 * Environment variables (Alibaba Cloud Bailian / DashScope):
 *   DASHSCOPE_API_KEY=sk-...                              # required
 *   DASHSCOPE_ANTHROPIC_BASE_URL   # default: https://dashscope.aliyuncs.com/api/v2
 *   DASHSCOPE_OPENAI_BASE_URL      # default: https://dashscope.aliyuncs.com/compatible-mode/v1
 *   QWEN_MODEL                     # default: qwen3.8-flash
 *
 * Run: npx tsx examples/advanced/38-disable-thinking-qwen.ts
 */
import { createAgent } from '../../src/index.js'

const MODEL = process.env.QWEN_MODEL || 'qwen3.8-flash'
const QUESTION = 'A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. How much is the ball? Answer in one sentence.'

interface RunSummary {
  apiType: string
  text: string
  thinkingBlocks: number
  durationS: string
  success: boolean
  error?: string
}

async function runDisabledThinking(
  apiType: 'anthropic-messages' | 'openai-completions',
  baseURL: string,
): Promise<RunSummary> {
  const agent = createAgent({
    apiType,
    model: MODEL,
    apiKey: process.env.DASHSCOPE_API_KEY,
    baseURL,
    // The point of this example: turn thinking OFF. Honored end-to-end
    // since v4.2.1 — see the header table for what each API shape receives.
    thinking: { type: 'disabled' },
    agent: { description: 'Qwen thinking-disabled agent', prompt: { type: 'preset', preset: 'default' }, maxTurns: 2 },
  })

  const t0 = performance.now()
  let text = ''
  let thinkingBlocks = 0
  let success = true
  let error: string | undefined

  for await (const event of agent.query(QUESTION)) {
    const msg = event
    if (msg.type === 'assistant') {
      for (const block of msg.message?.content || []) {
        if (block.type === 'thinking') {
          thinkingBlocks++
          console.log(`  [thinking block — UNEXPECTED when thinking is disabled] ${block.thinking?.slice(0, 80)}...`)
        }
        if (block.type === 'text') {
          text = block.text
        }
      }
    }
    if (msg.type === 'result' && msg.subtype === 'error') {
      success = false
      error = (msg.errors || []).join('; ') || 'unknown provider error'
      console.log(`  [provider error] ${error}`)
    }
  }

  await agent.close()

  return {
    apiType,
    text,
    thinkingBlocks,
    durationS: ((performance.now() - t0) / 1000).toFixed(1),
    success,
    error,
  }
}

async function main() {
  console.log('--- Example 38: Disable Thinking on qwen3.8-flash ---\n')
  console.log(`Model: ${MODEL}`)
  console.log(`Question: ${QUESTION}\n`)

  // --- Part 1: Anthropic-compatible endpoint ---
  console.log('=== Part 1: Anthropic-compatible (apiType: anthropic-messages) ===')
  console.log('  SDK sends native thinking: {type: "disabled"}\n')
  const anthropic = await runDisabledThinking(
    'anthropic-messages',
    process.env.DASHSCOPE_ANTHROPIC_BASE_URL || 'https://dashscope.aliyuncs.com/api/v2',
  )
  console.log(`  Answer: ${anthropic.text.slice(0, 200)}\n`)

  // --- Part 2: OpenAI-compatible endpoint ---
  console.log('=== Part 2: OpenAI-compatible (apiType: openai-completions) ===')
  console.log('  SDK dual-sends enable_thinking: false (top-level + chat_template_kwargs)\n')
  const openai = await runDisabledThinking(
    'openai-completions',
    process.env.DASHSCOPE_OPENAI_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  )
  console.log(`  Answer: ${openai.text.slice(0, 200)}\n`)

  // --- Summary ---
  console.log('=== Summary (thinking must be 0 on both shapes) ===')
  let failed = false
  for (const s of [anthropic, openai]) {
    const thinkingOk = s.thinkingBlocks === 0
    const completedOk = s.success
    const verdict = thinkingOk && completedOk ? '✓ thinking disabled' : '✗ FAIL'
    console.log(`  ${s.apiType.padEnd(22)} | thinking blocks: ${s.thinkingBlocks} | ${s.durationS}s | ${verdict}`)
    if (!thinkingOk) failed = true
    if (!completedOk) {
      failed = true
      console.log(`    error: ${s.error}`)
    }
  }

  if (failed) {
    console.log('\n❌ Example 38: at least one run failed (thinking still present or provider error).')
    process.exitCode = 1
  } else {
    console.log('\n✅ Example 38: thinking disabled on both API shapes.')
  }
}

main().catch((err) => {
  console.error('Example failed:', err.message)
  console.error('Hint: set DASHSCOPE_API_KEY (Alibaba Cloud Bailian key) and retry.')
  process.exit(1)
})

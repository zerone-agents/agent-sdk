/**
 * Example 35: WebSearch Provider Configuration & Fallback (#108)
 *
 * Exercises the new WebSearch resilience features through a REAL LLM:
 *
 *   Scenario A — transparent fallback recovery
 *     Exa is pointed at a dead endpoint (connection refused = retryable),
 *     so the tool silently falls back to Parallel. The LLM receives normal
 *     search results and answers as if nothing happened.
 *
 *   Scenario B — detailed error reaches the LLM
 *     Exa is configured with a bogus API key (401 = non-retryable, no
 *     fallback). The LLM receives the bounded, sanitized upstream error
 *     (HTTP status + provider message) as the tool_result and can explain
 *     what went wrong — instead of the old bare "Search failed: HTTP 401".
 *
 * Prerequisites:
 *   ZERONE_AGENT_API_KEY, ZERONE_AGENT_BASE_URL, ZERONE_AGENT_MODEL
 *
 * Run: npx tsx examples/advanced/35-web-search-providers.ts
 */
import {
  createAgent,
  DefaultToolServices,
  type WebSearchConfig,
} from '../../src/index.js'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const apiKey = process.env.ZERONE_AGENT_API_KEY
if (!apiKey) {
  console.error('Missing ZERONE_AGENT_API_KEY')
  process.exit(1)
}

function makeServices(webSearch: WebSearchConfig): DefaultToolServices {
  const services = new DefaultToolServices()
  services.webSearch = webSearch
  return services
}

async function runScenario(
  label: string,
  webSearch: WebSearchConfig,
  prompt: string,
  workdir: string,
): Promise<void> {
  console.log(`\n=== ${label} ===\n`)

  const agent = createAgent({
    model: process.env.ZERONE_AGENT_MODEL || 'claude-sonnet-4-6',
    cwd: workdir,
    apiType: process.env.ZERONE_AGENT_API_TYPE as any,
    apiKey,
    baseURL: process.env.ZERONE_AGENT_BASE_URL,
    toolServices: makeServices(webSearch),
    agent: {
      description: `WebSearch scenario: ${label}`,
      prompt:
        'You have a WebSearch tool. Use it exactly once when asked, then ' +
        'report the outcome in one or two sentences. If the tool returns ' +
        'an error, explain the error (status, provider message, retry hint) ' +
        'instead of pretending success.',
      maxTurns: 4,
      allowedTools: ['WebSearch'],
    },
  })

  for await (const event of agent.query(prompt)) {
    const msg = event as any
    if (msg.type === 'assistant') {
      for (const block of msg.message?.content || []) {
        if (block.type === 'tool_use') {
          console.log(`  tool_use      ${block.name} input=${JSON.stringify(block.input)}`)
        } else if (block.type === 'text' && block.text.trim()) {
          console.log(`  assistant     ${block.text}`)
        }
      }
    } else if (msg.type === 'tool_result') {
      const preview = String(msg.result.output).slice(0, 200).replace(/\s+/g, ' ')
      console.log(`  tool_result   is_error=${msg.result.is_error}`)
      console.log(`                "${preview}${preview.length >= 200 ? '…' : ''}"`)
    }
  }
}

async function main() {
  console.log('=== Example 35: WebSearch Provider Configuration & Fallback ===')

  const workdir = await mkdtemp(join(tmpdir(), 'websearch-providers-'))

  try {
    // Scenario A: dead Exa endpoint (retryable network error) -> Parallel
    // fallback. Any successful search result PROVES the fallback fired.
    await runScenario(
      'A: Exa endpoint dead -> fallback to Parallel',
      {
        providers: [
          { provider: 'exa', endpoint: 'http://127.0.0.1:9/mcp' },
          { provider: 'parallel' },
        ],
      },
      'Use WebSearch to search for "anthropic claude" and tell me the top result title.',
      workdir,
    )

    // Scenario B: bogus Exa key (401, non-retryable) -> the LLM receives the
    // detailed upstream auth error and should explain it.
    await runScenario(
      'B: bogus Exa API key -> detailed 401 reaches the LLM',
      {
        providers: [{ provider: 'exa', apiKey: 'bogus-key-for-demo' }],
      },
      'Use WebSearch to search for "anthropic claude" and tell me what happened.',
      workdir,
    )

    console.log('\nDone.')
  } finally {
    await rm(workdir, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})

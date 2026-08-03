/**
 * Example 36: WebFetch Provider Configuration & Fallback
 *
 * Exercises the new WebFetch 3-tier provider architecture through a REAL LLM:
 *
 *   Scenario A — default anonymous Jina (zero config)
 *     No services.webFetch set at all. The tool uses the built-in default
 *     chain [anonymous Jina → local]. The metadata header in the tool result
 *     shows which provider actually served the page.
 *
 *   Scenario B — dead Jina endpoint → fallback to local
 *     Jina is pointed at a dead endpoint (connection refused = retryable),
 *     so the tool silently falls back to the local readability+turndown
 *     provider. The LLM still answers correctly, and the metadata header
 *     shows `Provider: local` — proof the fallback fired.
 *
 *   Scenario C — SPA site (JS rendering verification)
 *     Default anonymous Jina fetches a JS-rendered React docs page. If the
 *     result mentions useState/useEffect, Jina rendered the JS (the local
 *     provider would see an empty shell). May WARN if the anonymous
 *     20 RPM rate limit (shared per IP across all users) kicks in.
 *
 * Prerequisites:
 *   ZERONE_AGENT_API_KEY, ZERONE_AGENT_BASE_URL, ZERONE_AGENT_MODEL
 *
 * Run: npx tsx examples/advanced/36-web-fetch-providers.ts
 */
import { createAgent, DefaultToolServices } from '../../src/index.js'
import type { WebFetchConfig } from '../../src/tools/web-fetch-providers.js'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const apiKey = process.env.ZERONE_AGENT_API_KEY
if (!apiKey) {
  console.error('Missing ZERONE_AGENT_API_KEY')
  process.exit(1)
}

function makeServices(webFetch?: WebFetchConfig): DefaultToolServices {
  const services = new DefaultToolServices()
  if (webFetch) services.webFetch = webFetch
  return services
}

async function runScenario(
  label: string,
  webFetch: WebFetchConfig | undefined,
  prompt: string,
  workdir: string,
): Promise<{ toolUsed: boolean; resultText: string; isError: boolean }> {
  console.log(`\n=== ${label} ===\n`)

  const agent = createAgent({
    model: process.env.ZERONE_AGENT_MODEL || 'claude-sonnet-4-6',
    cwd: workdir,
    apiType: process.env.ZERONE_AGENT_API_TYPE as any,
    apiKey,
    baseURL: process.env.ZERONE_AGENT_BASE_URL,
    toolServices: makeServices(webFetch),
    agent: {
      description: `WebFetch scenario: ${label}`,
      prompt:
        'You have a WebFetch tool. Use it exactly once when asked, then ' +
        'report the outcome in one or two sentences. The result includes a ' +
        'metadata header (Title/URL/Content-Type/Provider/Extracted/Length) ' +
        'before the content — note which provider was used.',
      maxTurns: 4,
      allowedTools: ['WebFetch'],
    },
  })

  let toolUsed = false
  let resultText = ''
  let isError = false

  for await (const event of agent.query(prompt)) {
    const msg = event as any
    if (msg.type === 'assistant') {
      for (const block of msg.message?.content || []) {
        if (block.type === 'tool_use') {
          toolUsed = true
          console.log(`  tool_use      ${block.name} input=${JSON.stringify(block.input)}`)
        } else if (block.type === 'text' && block.text.trim()) {
          console.log(`  assistant     ${block.text}`)
        }
      }
    } else if (msg.type === 'tool_result') {
      resultText = String(msg.result.output)
      isError = Boolean(msg.result.is_error)
      const preview = resultText.slice(0, 200).replace(/\s+/g, ' ')
      console.log(`  tool_result   is_error=${msg.result.is_error}`)
      console.log(`                "${preview}${preview.length >= 200 ? '…' : ''}"`)
    }
  }

  return { toolUsed, resultText, isError }
}

function providerOf(resultText: string): string | null {
  const m = /^Provider:\s*(\S+)$/m.exec(resultText)
  return m ? m[1] : null
}

async function main() {
  console.log('=== Example 36: WebFetch Provider Configuration & Fallback ===')

  const workdir = await mkdtemp(join(tmpdir(), 'webfetch-providers-'))

  try {
    // Scenario A: zero config -> default [anonymous Jina -> local]. A
    // successful fetch proves the default chain works out of the box; the
    // metadata header shows which provider served it (normally jina, local
    // if Jina is rate-limited or down).
    const a = await runScenario(
      'A: default anonymous Jina (zero config)',
      undefined,
      'Use WebFetch to fetch https://example.com and tell me the page\'s main message.',
      workdir,
    )
    const aProvider = providerOf(a.resultText)
    const aPass =
      a.toolUsed && !a.isError && (aProvider === 'jina' || aProvider === 'local')
    console.log(
      `  ${aPass ? 'PASS' : 'WARN'} scenario A: provider=${aProvider ?? 'unknown'} ` +
        `(expected jina, local is a valid degradation)`,
    )

    // Scenario B: dead Jina endpoint (connection refused = retryable) ->
    // local fallback. `Provider: local` in the result PROVES the fallback
    // fired; the LLM should still answer correctly.
    const b = await runScenario(
      'B: Jina endpoint dead -> fallback to local',
      {
        providers: [
          { provider: 'jina', endpoint: 'http://127.0.0.1:9' },
          { provider: 'local' },
        ],
      },
      'Use WebFetch to fetch https://example.com and tell me the page\'s main message.',
      workdir,
    )
    const bProvider = providerOf(b.resultText)
    const bPass = b.toolUsed && !b.isError && bProvider === 'local'
    console.log(
      `  ${bPass ? 'PASS' : 'WARN'} scenario B: provider=${bProvider ?? 'unknown'} ` +
        `(expected local — fallback fired)`,
    )

    // Scenario C: SPA site via default anonymous Jina. react.dev requires
    // JS rendering; if the content mentions useState/useEffect, Jina did
    // the rendering. May WARN on anonymous rate limit (20 RPM shared).
    const c = await runScenario(
      'C: SPA site (react.dev) proves JS rendering via Jina',
      undefined,
      'Use WebFetch to fetch https://react.dev/reference/react and tell me: ' +
        'does this page mention useState or useEffect hooks? (one word yes/no)',
      workdir,
    )
    const cProvider = providerOf(c.resultText)
    const cHasHooks = /useState|useEffect/.test(c.resultText)
    const cPass = c.toolUsed && !c.isError && cHasHooks
    console.log(
      `  ${cPass ? 'PASS' : 'WARN'} scenario C: provider=${cProvider ?? 'unknown'} ` +
        `hooks-mentioned=${cHasHooks} (WARN is expected on Jina rate limit)`,
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

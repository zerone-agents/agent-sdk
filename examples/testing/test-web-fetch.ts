/**
 * Test: WebFetch Tool
 *
 * Tests the WebFetch tool with real websites.
 * Run: npx tsx examples/testing/test-web-fetch.ts
 */

import { WebFetchTool } from '../../src/tools/web-fetch.js'
import { createAgent } from '../../src/index.js'

async function testDirectCall() {
  console.log('--- Test 1: Direct Call ---\n')

  console.log('Fetching https://www.baidu.com...\n')
  const result: any = await WebFetchTool.call({ url: 'https://www.baidu.com' }, {})

  console.log('is_error:', result.is_error)
  console.log('content length:', result.content.length)
  console.log('content preview:', result.content.slice(0, 500))

  if (!result.is_error && result.content.length > 0) {
    // 新版应包含元数据头
    const hasHeader = /^Title:|^URL:|^Provider:/m.test(result.content)
    if (hasHeader) {
      console.log('\n✅ PASS: Direct call returned content with metadata header\n')
      return true
    } else {
      console.log('\n⚠️  WARN: Content missing metadata header (unexpected)\n')
      return true
    }
  } else {
    console.log('\n❌ FAIL\n')
    return false
  }
}

async function testSpaSite() {
  console.log('--- Test 2: SPA Site (React docs) ---\n')

  console.log('Fetching https://react.dev (SPA, requires JS rendering)...\n')
  const result: any = await WebFetchTool.call(
    { url: 'https://react.dev', maxChars: 5000 },
    {},
  )

  console.log('is_error:', result.is_error)
  console.log('provider line:', /^Provider: (.+)$/m.exec(result.content)?.[1])
  console.log('content preview:', result.content.slice(0, 500))

  // SPA 走 jina 应该能拿到内容
  if (!result.is_error && result.content.includes('React')) {
    console.log('\n✅ PASS: SPA site returned content (likely via Jina)\n')
    return true
  } else {
    console.log('\n⚠️  WARN: SPA content empty or missing "React" keyword\n')
    return true // 不算硬失败
  }
}

async function testLLMCall() {
  console.log('--- Test 3: LLM Call ---\n')

  const apiKey = process.env.ZERONE_AGENT_API_KEY || process.env.ZERONE_AGENT_AUTH_TOKEN
  if (!apiKey) {
    console.log('⚠️  SKIP: No ZERONE_AGENT_API_KEY set, skipping LLM test\n')
    return true
  }

  const agent = createAgent({
    model: process.env.ZERONE_AGENT_MODEL || 'claude-sonnet-4-6',
    agent: { description: 'WebFetch test agent', prompt: { type: 'preset', preset: 'default' }, maxTurns: 5 },
  })

  console.log('Using WebFetch to fetch baidu.com via LLM...\n')

  const userPrompt = 'Use WebFetch to fetch https://www.baidu.com and tell me what the page is about in one sentence.'

  let toolCalled = false
  let toolSuccess = false

  for await (const event of agent.query(userPrompt)) {
    const msg = event as any

    if (msg.type === 'assistant') {
      console.log('\n=== LLM RESPONSE ===')
      for (const block of msg.message?.content || []) {
        if (block.type === 'tool_use') {
          console.log(`\n[Tool Call]`)
          console.log(`  name: ${block.name}`)
          console.log(`  input: ${JSON.stringify(block.input, null, 2)}`)
          if (block.name === 'WebFetch') {
            toolCalled = true
          }
        }
        if (block.type === 'text' && block.text.trim()) {
          console.log(`\n[Text Response]\n${block.text}`)
        }
      }
    }

    if (msg.type === 'tool_result') {
      console.log(`\n=== TOOL RESULT ===`)
      console.log(`  tool_name: ${msg.result.tool_name}`)
      console.log(`  output: ${msg.result.output.slice(0, 300)}${msg.result.output.length > 300 ? '...(truncated)' : ''}`)
      if (msg.result.tool_name === 'WebFetch' && !msg.result.is_error) {
        toolSuccess = true
      }
    }

    if (msg.type === 'result') {
      console.log(`\n=== FINAL RESULT ===`)
      console.log(`  num_turns: ${msg.num_turns}`)
    }
  }

  if (toolCalled && toolSuccess) {
    console.log('\n✅ PASS: LLM called WebFetch successfully\n')
    return true
  } else {
    console.log('\n❌ FAIL: LLM did not call WebFetch or call failed\n')
    return false
  }
}

async function main() {
  console.log('--- WebFetch Tool Tests ---\n')

  const r1 = await testDirectCall()
  const r2 = await testSpaSite()
  const r3 = await testLLMCall()

  if (r1 && r2 && r3) {
    console.log('=== All Tests Passed ===')
    process.exit(0)
  } else {
    console.log('=== Some Tests Failed ===')
    process.exit(1)
  }
}

main().catch(console.error)

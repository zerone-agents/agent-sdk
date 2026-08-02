/**
 * Offline verification: feed REAL errors thrown by the real libraries
 * (Anthropic SDK + undici fetch) into classifyError.
 * 127.0.0.1:59999 = connection refused; .invalid TLD = DNS failure (RFC 2606).
 */
import Anthropic from '@anthropic-ai/sdk'
import { classifyError, isConnectionError } from '../../src/utils/retry.js'

function dumpChain(err: any, depth = 0): void {
  if (!err || depth > 5) return
  console.log(
    `${'  '.repeat(depth)}↳ name=${err.name} code=${err.code ?? '-'} message=${JSON.stringify(err.message)}`,
  )
  dumpChain(err.cause, depth + 1)
}

function check(label: string, err: any): boolean {
  console.log(`\n=== ${label} ===`)
  dumpChain(err)
  const c = classifyError(err)
  console.log(`classifyError → type=${c.type} isRetryable=${c.isRetryable}`)
  const ok = c.type === 'connection' && c.isRetryable && isConnectionError(err)
  console.log(ok ? 'PASS' : 'FAIL')
  return ok
}

let allOk = true

// 1. Anthropic SDK, connection refused (equivalent to network down)
const client = new Anthropic({ apiKey: 'test-key', baseURL: 'http://127.0.0.1:59999', maxRetries: 0 })
try {
  await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'hi' }],
  })
  console.log('UNEXPECTED: request succeeded')
  allOk = false
} catch (err: any) {
  allOk = check('Anthropic SDK — ECONNREFUSED', err) && allOk
}

// 2. Anthropic SDK, DNS failure
const clientDns = new Anthropic({ apiKey: 'test-key', baseURL: 'https://nonexistent.invalid', maxRetries: 0 })
try {
  await clientDns.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'hi' }],
  })
  console.log('UNEXPECTED: request succeeded')
  allOk = false
} catch (err: any) {
  allOk = check('Anthropic SDK — ENOTFOUND (DNS)', err) && allOk
}

// 3. Raw fetch (OpenAI provider path), connection refused
try {
  await fetch('http://127.0.0.1:59999/v1/chat/completions', { method: 'POST' })
  console.log('UNEXPECTED: fetch succeeded')
  allOk = false
} catch (err: any) {
  allOk = check('raw fetch — ECONNREFUSED', err) && allOk
}

// 4. Raw fetch, DNS failure
try {
  await fetch('https://nonexistent.invalid/v1/chat/completions', { method: 'POST' })
  console.log('UNEXPECTED: fetch succeeded')
  allOk = false
} catch (err: any) {
  allOk = check('raw fetch — ENOTFOUND (DNS)', err) && allOk
}

console.log(allOk ? '\nALL PASS' : '\nSOME FAILED')
process.exit(allOk ? 0 : 1)

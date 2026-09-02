// Spawned by src/mcp/stdio-stderr.e2e.test.ts via tsx against REAL source
// (no module mocks). Excluded from the published package via
// tsconfig.build.json ("src/mcp/fixtures").
// argv: <stderrPolicy|'-'> <secret>
import { connectMCPServer } from '../client.js'

const [, , policyArg, secret] = process.argv
if (!policyArg || !secret) {
  console.error('usage: stdio-stderr-wrapper.ts <stderrPolicy|"-"> <secret>')
  process.exit(2)
}

const conn = await connectMCPServer('e2e', {
  type: 'stdio',
  command: process.execPath,
  args: ['-e', `process.stderr.write(${JSON.stringify(secret + '\n')}); process.exit(1)`],
  retryPolicy: { timeoutMs: 3000, maxRetries: 0 },
  ...(policyArg === '-' ? {} : { stderr: policyArg as 'inherit' | 'ignore' }),
})
// The fixture child writes the secret to ITS stderr and exits 1 → error
// connection (the leak window is the child's stderr write, not the handshake).
console.log(`status=${conn.status}`)
await conn.close()

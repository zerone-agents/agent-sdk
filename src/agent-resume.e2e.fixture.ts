/**
 * Child-process fixture for the issue #115 cross-process e2e.
 * argv[2] = phase: 'a' (activate + save, print sessionId) | 'b' (resume,
 * print the first provider request's Memory/MemorySearch tool JSON).
 * argv[3] = sessionId (phase b only). HOME is set by the parent test.
 */
import { Agent } from './agent.js'
import { createMemoryService } from './memory/service.js'
import { InMemoryMemoryStorage } from './memory/in-memory-storage.js'
import type { LLMProvider } from './providers/types.js'

async function main(): Promise<void> {
  const phase = process.argv[2]
  const memoryService = createMemoryService({ storage: new InMemoryMemoryStorage() })
  await memoryService.start()
  const captured: any[] = []
  const provider: LLMProvider = {
    apiType: 'anthropic-messages',
    async createMessage() { throw new Error('not used') },
    async *createMessageStream(params: any) {
      captured.push({ tools: params.tools ?? [] })
      yield { type: 'text', index: 0, delta: 'ok' }
      yield { type: 'done', index: -1 }
    },
  }
  const baseOpts: any = {
    model: 'test-model',
    apiKey: 'test-key',
    memoryService,
    includePartialMessages: true,
    persistSession: true,      // phase a MUST auto-save the session
    enableFileRevert: false,   // no git snapshot side effects
    mcpServers: {},
  }
  if (phase === 'b') baseOpts.resume = process.argv[3]
  const agent = new Agent(baseOpts)
  ;(agent as any).provider = provider
  if (phase === 'a') {
    // Direct registry activation (find-tool.ts:136 equivalent — see plan §Shared Helpers).
    // NB: Set.add is single-arg — one call per name.
    const registry = (agent as any).effectiveBaseServices().findTool
    registry.activatedTools.add('Memory')
    registry.activatedTools.add('MemorySearch')
    await agent.prompt('work')   // completes → auto-save carries the activation set
    console.log(`SID=${(agent as any).sid}`)
  } else {
    await agent.prompt('continue')
    const entries = captured[0].tools
      .filter((t: any) => t.name === 'Memory' || t.name === 'MemorySearch')
      .map((t: any) => ({ name: t.name, description: t.description, inputSchema: t.input_schema }))
    console.log(`TOOLS=${JSON.stringify(entries)}`)
  }
  await memoryService.stop()
}

main().then(
  () => process.exit(0),
  (err) => { console.error(err); process.exit(1) },
)

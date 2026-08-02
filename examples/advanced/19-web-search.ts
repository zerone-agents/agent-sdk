/**
 * Example 19: Web Search Tool
 *
 * Tests WebSearchTool using Exa AI MCP service for real-time web search.
 * No API key required - directly calls the tool.
 *
 * Run: npx tsx examples/19-web-search.ts
 * Run: npx tsx examples/19-web-search.ts "Node.js 22 new features"
 */
import { WebSearchTool } from '../../src/tools/web-search.ts'
import { createEmptyServices } from '../../src/tools/services.ts'

async function main() {
  console.log('--- Example 19: Web Search Tool ---\n')

  const query = process.argv[2] || 'TypeScript 5.7 release highlights'
  const numResults = parseInt(process.argv[3]) || 5

  console.log(`Query: "${query}"`)
  console.log(`Results: ${numResults}\n`)
  console.log('Calling Exa AI MCP...\n')

  const result = await WebSearchTool.call({ query, numResults }, { cwd: process.cwd() })

  console.log('=== Search Results ===\n')
  if (typeof result === 'string') {
    console.log(result)
  } else if (result.is_error) {
    console.log(`Error: ${typeof result.content === 'string' ? result.content : JSON.stringify(result.content)}`)
  } else {
    console.log(typeof result.content === 'string' ? result.content : JSON.stringify(result.content))
  }

  // --- Configured providers demo (anonymous Exa -> anonymous Parallel fallback) ---
  console.log('\n=== Configured providers demo ===\n')
  const services = createEmptyServices()
  services.webSearch = {
    providers: [{ provider: 'exa' }, { provider: 'parallel' }],
  }
  const configured = await WebSearchTool.call(
    { query, numResults },
    { cwd: process.cwd(), agentId: 'example-19', services },
  )
  console.log(
    typeof configured === 'string'
      ? configured
      : typeof configured.content === 'string'
        ? configured.content
        : JSON.stringify(configured.content),
  )
}

main().catch(console.error)
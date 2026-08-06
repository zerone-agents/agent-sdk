# Contributing

Contributions are welcome. This guide covers setup, conventions, and the path from idea to merged PR. For project overview, see the [README](./README.md) and [Architecture](./docs/architecture.md).

## Development setup

Requires **Node.js 22+** (uses native `fs.promises.glob` and `import.meta.resolve`).

```bash
git clone https://github.com/zerone-agents/agent-sdk.git
cd agent-sdk
npm install
npm test        # verify the suite is green before starting
```

No build step is needed for development — `vitest` and `tsx` transpile TypeScript on the fly. Build only when preparing a release: `npm run build`.

## Common scripts

| Script | Purpose |
|--------|---------|
| `npm test` | Run the full vitest suite (single pass) |
| `npm run test:watch` | Watch mode for iterative development |
| `npm run typecheck` | `tsc --noEmit` — catch type errors across the repo |
| `npm run build` | Compile `src/` → `dist/` via `tsc -p tsconfig.build.json` (also copies tool `.txt` resources) |
| `npm run dev` | Watch-mode `tsc` for background compilation |
| `npm run test:examples` | Run `examples/basic/01-simple-query.ts` as a smoke test |
| `npm run test:examples:all` | Iterate every example under `examples/` (needs API keys for most) |
| `npm run web` | Launch the example web chat server at `examples/web/server.ts` |

To run a single test file during iteration:

```bash
npm test -- src/agent.message-log.test.ts
```

## Project structure

```
src/
├── agent.ts                # Public Agent class + createAgent() + query()
├── engine.ts               # QueryEngine — the agentic loop
├── engine/                 # Engine sub-modules (prompt-builder, tool-executor, ...)
├── types.ts                # Public type definitions (AgentOptions, Message, ...)
├── tool-helper.ts          # tool() — Zod-schema tool helper
├── sdk-mcp-server.ts       # createSdkMcpServer — in-process MCP server
├── hooks.ts                # 24 lifecycle events + HookRegistry
├── resolve-agent.ts        # Agent definition resolver (merges options + system prompt)
├── session.ts              # Session persistence / resume / fork
├── session-revert.ts       # Programmatic revert API
├── providers/              # LLM backends: Anthropic, OpenAI; createProvider()
├── tools/                  # 20 built-in tools + defineTool + tool registry
├── skills/                 # Skill registry + filesystem loader
├── mcp/                    # MCP client (stdio/SSE/HTTP) + connection pool
├── prompts/                # System prompt builders + presets
├── snapshot/               # Git-based file snapshot engine for revert
├── cron/                   # Cron storage + jitter
└── utils/                  # Shared helpers (file-cache, compact, session-turns, ...)
```

Public exports are re-exported from `src/index.ts`. Anything not exported from `index.ts` is internal and may change without notice.

## Code style

Enforced by `tsconfig.json` (`strict: true`) and review — there is no ESLint or Prettier config.

- **TypeScript strict**, no `any` without justification. `any` is acceptable at provider/tool-call boundaries where input shape is genuinely dynamic.
- **ESM only**: `package.json` has `"type": "module"`. Use `import` / `export`, never `require`.
- **`.js` suffix in relative imports**: `import { x } from './types.js'` — required by `NodeNext` module resolution even though the source is `.ts`.
- **Node 22+ APIs are allowed**: `import.meta.resolve`, `fs.promises.glob`, `Iterator.from`, etc. Do not add polyfills.
- **Co-located tests**: see Testing convention below.
- **No unused exports**: if a function is internal, do not export it. Public API surface lives in `src/index.ts`.
- **Error handling at boundaries only**: validate at the API/tool-call boundary; trust internal callers.
- **No backwards-compat shims**: breaking changes are acceptable in minor bumps. Delete old code; do not deprecate-and-alias unless explicitly required.

## Branch and commit conventions

### Branch naming

Feature branches follow `<type>/<topic>-<issue?>`:

```
fix/pdf-standard-fonts-11
feat/halved-compaction
docs/readme-refactor
chore/untrack-superpowers
```

`main` is always green and deployable. Do not push directly to `main`.

### Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/) prefixes:

| Prefix | Use for |
|--------|---------|
| `feat:` | New user-facing feature or capability |
| `fix:` | Bug fix |
| `docs:` | Documentation only (README, docs/, examples) |
| `test:` | Test additions or fixes, no production code change |
| `chore:` | Tooling, dependencies, refactors with no behavior change |

Include the issue number in the subject when applicable: `fix: resolve pdf warning (#11)`. Keep the subject under 70 characters; put detail in the body.

## Testing convention

Test files use the **co-located `.test.ts`** convention (vitest default): each test file sits next to the source file it covers.

```
src/
├── engine.ts
├── engine.test.ts        # ✓ co-located
└── tools/
    ├── task.ts
    └── task.test.ts      # ✓ co-located
```

Do **not** use `__tests__/` subdirectories — that is a Jest-era holdover and the project has migrated away from it.

A test file's unit is the source file it covers. Cross-module integration tests can live wherever makes sense (often next to the higher-level module, e.g. `src/utils/session-turns-integration.test.ts`).

### When tests need fixtures

- **Small text/JSON fixtures**: inline in the test file.
- **Binary fixtures**: commit to `src/<module>/test-fixtures/` next to the test that uses them. The `files` field in `package.json` only ships `dist/`, so fixtures do not bloat the npm package.
- **Generated fixtures**: commit the binary output, not the generator. The generator script is a one-time local tool and does not belong in the repo.

## Adding a new built-in tool

Built-in tools live in `src/tools/` and are registered in `src/tools/index.ts`. Minimum viable tool:

```typescript
// src/tools/echo.ts
import { defineTool } from './types.js'

export const EchoTool = defineTool({
  name: 'Echo',
  description: 'Echo back the input text. Useful for debugging.',
  inputSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'The text to echo back',
      },
    },
    required: ['text'],
  },
  isReadOnly: true,
  async call(input) {
    return input.text
  },
})
```

Register it:

```typescript
// src/tools/index.ts
import { EchoTool } from './echo.js'

const ALL_TOOLS: ToolDefinition[] = [
  // ...existing tools
  EchoTool,
]

// And add to the re-export block:
export { EchoTool }
```

Add a co-located test:

```typescript
// src/tools/echo.test.ts
import { describe, it, expect } from 'vitest'
import { EchoTool } from './echo.js'

describe('EchoTool', () => {
  it('returns the input text', async () => {
    const result = await EchoTool.call(
      { text: 'hello' },
      { cwd: '/', toolUseId: 'test', agentId: 'test' } as any,
    )
    expect(result.content).toBe('hello')
    expect(result.is_error).toBe(false)
  })
})
```

For a more involved example (description loaded from a `.txt` file, sub-agent invocation, permission handling), see `src/tools/task.ts`. The `.txt` pattern keeps long tool descriptions out of TypeScript source and gets bundled by the build script.

## Pull request process

1. **Fork and branch** from `main`: `git checkout -b feat/<your-topic>`.
2. **Write tests first** when fixing a bug or adding behavior (TDD). The test should fail before the fix and pass after.
3. **Run the full suite locally**: `npm test` and `npm run typecheck` must both be green.
4. **Push and open a PR** against `main`. The PR description should include:
   - Summary of changes
   - Any breaking changes and migration notes
   - Verification performed (tests run, examples smoke-tested, manual repro)
5. **Respond to review**. Reviewers may ask for tests, scope reductions, or doc updates.
6. **Squash or rebase** if asked; the maintainer merges via GitHub's merge button (merge commits, not squash, are the repo default).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](./LICENSE).

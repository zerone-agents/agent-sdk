# Agent SDK

[![npm version](https://img.shields.io/npm/v/@zerone-agent/agent-sdk)](https://www.npmjs.com/package/@zerone-agent/agent-sdk)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

**English** | [简体中文](./README.zh-CN.md)

Open-source Agent SDK that runs the full agent loop **in-process** — no subprocess or CLI required. Supports both **Anthropic** and **OpenAI-compatible** APIs. Deploy anywhere: cloud, serverless, Docker, CI/CD.

## Features

- **In-process agent loop** — runs anywhere Node runs: cloud, serverless, Docker, CI/CD
- **Multi-provider** — Anthropic, OpenAI / DeepSeek, or custom providers
- **30+ built-in tools** — file I/O, search, bash, web, MCP, subagents, skills
- **Streaming + blocking** — `query()` for events, `prompt()` for promises
- **Session persistence** — automatic compaction when context grows
- **Permission system** — per-tool allow/deny with hooks for custom policy
- **Skills + Subagents** — composable in-context capabilities

## Concepts

Five core abstractions compose every agent run:

- **Agent** — stateful wrapper around a session. Holds the tool pool, MCP connections, hooks, and history. Created via `createAgent()`.
- **QueryEngine** — runs the agentic loop on each `prompt()` / `query()` call: API request → tool calls → repeat until turn limit or completion.
- **Tool** — a function the model can invoke. The SDK ships 20+ built-in tools (Bash, Read, Write, Edit, Glob, Grep, WebFetch, ...). Custom tools are defined with `tool()` (Zod schema) or `defineTool()` (low-level).
- **Provider** — LLM backend abstraction. `AnthropicProvider` and `OpenAIProvider` ship built-in; custom providers implement the `LLMProvider` interface.
- **Skill** — a reusable prompt template (Claude-Code-compatible). Skills are loaded programmatically via `registerSkill()` or from the filesystem (`.agents/skills/<name>/SKILL.md`); the SDK ships no built-in skills.

For the full component model and request flow, see [Architecture](docs/architecture.md).

## Installation

```bash
npm install @zerone-agent/agent-sdk
```

Requires Node.js 22 or later.

Set your API key (or use the `apiKey` option in code):

```bash
export ZERONE_AGENT_API_KEY=...     # primary
# or
export ZERONE_AGENT_AUTH_TOKEN=...  # alternative auth token
```

For other providers (DeepSeek, third-party Anthropic-compatible endpoints, custom base URLs), see [Provider Configuration](docs/api.md#provider-configuration).

## Quick Start

**Streaming** (events as they arrive):

```typescript
import { createAgent } from "@zerone-agent/agent-sdk";

const agent = createAgent({ model: "claude-sonnet-4-6" });

for await (const event of agent.query("Write a haiku about TypeScript.")) {
  if (event.type === "assistant") {
    for (const block of event.message.content) {
      if ("text" in block) process.stdout.write(block.text);
    }
  }
}
```

**Blocking** (single result):

```typescript
import { createAgent } from "@zerone-agent/agent-sdk";

const agent = createAgent();
const result = await agent.prompt("List 3 JavaScript testing frameworks.");
console.log(result.text);
```

For the full set of patterns (multi-turn, custom tools, skills, hooks, MCP, subagents, permissions, web UI), see [Getting Started](docs/getting-started.md).

## Documentation

| Document | Contents |
|----------|----------|
| [Getting Started](docs/getting-started.md) | Full quick start with 8 example patterns |
| [API Reference](docs/api.md) | Top-level functions, Agent methods, options, env vars |
| [Built-in Tools](docs/tools.md) | 20+ tools + PDF support details |
| [Architecture](docs/architecture.md) | Component model and request flow |
| [Examples](docs/examples.md) | 30+ runnable examples by category |

## Examples

Browse the [`examples/`](examples/) directory or see the [curated examples index](docs/examples.md) for guidance by use case.

Run any example:

```bash
npx tsx examples/basic/01-simple-query.ts
```

## Community

- **Issues & feature requests**: [github.com/zerone-agents/agent-sdk/issues](https://github.com/zerone-agents/agent-sdk/issues)
- **Source code**: [github.com/zerone-agents/agent-sdk](https://github.com/zerone-agents/agent-sdk)

## License

MIT

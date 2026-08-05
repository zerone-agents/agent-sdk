# Architecture

Overview of the Agent SDK component model and request flow.

```
┌──────────────────────────────────────────────────────┐
│                   Your Application                    │
│                                                       │
│   import { createAgent } from '@zerone-agent/agent-sdk' │
└────────────────────────┬─────────────────────────────┘
                         │
              ┌──────────▼──────────┐
              │       Agent         │  Session state, tool pool,
              │  query() / prompt() │  MCP connections, hooks
              └──────────┬──────────┘
                         │
              ┌──────────▼──────────┐
              │    QueryEngine      │  Agentic loop:
              │   submitMessage()   │  API call → tools → repeat
              └──────────┬──────────┘
                         │
         ┌───────────────┼───────────────┐
         │               │               │
   ┌─────▼─────┐  ┌─────▼─────┐  ┌─────▼─────┐
   │  Provider  │  │  35 Tools │  │    MCP     │
   │ Anthropic  │  │ Bash,Read │  │  Servers   │
   │  OpenAI    │  │ Edit,...  │  │ stdio/SSE/ │
   │ DeepSeek   │  │ + Skills  │  │ HTTP/SDK   │
   └───────────┘  └───────────┘  └───────────┘
```

**Key internals:**

| Component             | Description                                                        |
| --------------------- | ------------------------------------------------------------------ |
| **Provider layer**    | Abstracts Anthropic / OpenAI API differences                       |
| **QueryEngine**       | Core agentic loop with auto-compact, retry, tool orchestration     |
| **Skill system**      | Reusable prompt templates with 5 bundled skills                    |
| **Hook system**       | 20 lifecycle events integrated into the engine                     |
| **Auto-compact**      | Summarizes conversation when context window fills up               |
| **Micro-compact**     | Truncates oversized tool results                                   |
| **Retry**             | Exponential backoff for rate limits and transient errors            |
| **Token estimation**  | Rough token counting with pricing for Claude, GPT, DeepSeek models |
| **File cache**        | LRU cache (100 entries, 25 MB) for file reads                      |
| **Session storage**   | Persist / resume / fork sessions on disk                           |
| **Context injection** | Git status + AGENT.md automatically injected into system prompt    |

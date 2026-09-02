# Examples

The [`examples/`](../examples/) directory contains 30+ runnable examples organized by category. This page is the curated index; the directory itself is the source of truth.

Full examples are in [`examples/`](../examples/) organized by category:

| Category | Contents |
| --- | --- |
| **basic/** | Simple queries, multi-tool, multi-turn, prompt API, system prompts |
| **tools/** | Custom tools, permissions, binary read, TodoWrite, Edit tool |
| **agents/** | Subagents, task tool modes, multitask orchestration |
| **skills/** | In-context skills, filesystem skills agent |
| **sessions/** | Session revert, fork, query limits |
| **streaming/** | Streaming responses, streaming with tools, subtask events |
| **mcp/** | MCP server integration, custom MCP tools |
| **advanced/** | Hooks, OpenAI/official API compat, web search, compact, reasoning effort |
| **testing/** | Test utilities for parallel tools, max tokens, connection errors |

### Basic

| Example | Description |
| --- | --- |
| [`examples/basic/01-simple-query.ts`](../examples/basic/01-simple-query.ts) | Streaming query with event handling |
| [`examples/basic/02-multi-tool.ts`](../examples/basic/02-multi-tool.ts) | Multi-tool orchestration (Glob + Bash) |
| [`examples/basic/03-multi-turn.ts`](../examples/basic/03-multi-turn.ts) | Multi-query session persistence |
| [`examples/basic/04-prompt-api.ts`](../examples/basic/04-prompt-api.ts) | Blocking `prompt()` API |
| [`examples/basic/05-custom-system-prompt.ts`](../examples/basic/05-custom-system-prompt.ts) | Custom system prompt |

### Tools & Permissions

| Example | Description |
| --- | --- |
| [`examples/tools/07-custom-tools.ts`](../examples/tools/07-custom-tools.ts) | Custom tools with `defineTool()` |
| [`examples/tools/10-permissions.ts`](../examples/tools/10-permissions.ts) | Read-only agent with tool restrictions |
| [`examples/tools/21-test-read-binary.ts`](../examples/tools/21-test-read-binary.ts) | Read tool binary file handling (images, tar.gz) |
| [`examples/tools/22-todowrite.ts`](../examples/tools/22-todowrite.ts) | TodoWrite tool for structured task tracking |
| [`examples/tools/28-edit-tool-features.ts`](../examples/tools/28-edit-tool-features.ts) | Advanced Edit tool features (old_string validation, multi-file) |
| [`examples/tools/37-read-directory.ts`](../examples/tools/37-read-directory.ts) | Directory listing with the Read tool |
| [`examples/tools/38-tool-env-isolation.ts`](../examples/tools/38-tool-env-isolation.ts) | Control env vars visible to Bash/Grep subprocesses (host-embed isolation) |

### Agents & Subagents

| Example | Description |
| --- | --- |
| [`examples/agents/09-subagents.ts`](../examples/agents/09-subagents.ts) | Subagent delegation |
| [`examples/agents/29-task-tool-modes.ts`](../examples/agents/29-task-tool-modes.ts) | Task tool `subagent_type` modes (explore vs general) |
| [`examples/agents/30-multitask.ts`](../examples/agents/30-multitask.ts) | MultiTask tool for parallel subagent orchestration |

### Skills

| Example | Description |
| --- | --- |
| [`examples/skills/12-skills.ts`](../examples/skills/12-skills.ts) | Skill system usage |
| [`examples/skills/14-filesystem-skills-agent.ts`](../examples/skills/14-filesystem-skills-agent.ts) | Filesystem skills loading |
| [`examples/skills/15-nested-skills.ts`](../examples/skills/15-nested-skills.ts) | Nested skill directories + frontmatter override + variable substitution |

### Sessions & History

| Example | Description |
| --- | --- |
| [`examples/sessions/23-session-revert.ts`](../examples/sessions/23-session-revert.ts) | Session revert to previous message state |
| [`examples/sessions/24-fork-from-message.ts`](../examples/sessions/24-fork-from-message.ts) | Fork session from any message |
| [`examples/sessions/25-revert-fork-guide.ts`](../examples/sessions/25-revert-fork-guide.ts) | Complete guide: revert vs fork patterns |
| [`examples/sessions/26-agent-revert-api.ts`](../examples/sessions/26-agent-revert-api.ts) | Agent revert API (programmatic session revert) |
| [`examples/sessions/27-caller-revert-flow.ts`](../examples/sessions/27-caller-revert-flow.ts) | Caller-controlled revert flow |
| [`examples/sessions/31-session-query-limit.ts`](../examples/sessions/31-session-query-limit.ts) | `maxSessionQueries` limit to bound session context |

### Streaming

| Example | Description |
| --- | --- |
| [`examples/streaming/16-streaming.ts`](../examples/streaming/16-streaming.ts) | Streaming responses (line-delimited JSON events) |
| [`examples/streaming/17-streaming-with-tools.ts`](../examples/streaming/17-streaming-with-tools.ts) | Streaming with tool calls and results |
| [`examples/streaming/33-subtask-completed-event.ts`](../examples/streaming/33-subtask-completed-event.ts) | Subtask completed event in streaming mode |
| [`examples/streaming/34-streaming-tool-results.ts`](../examples/streaming/34-streaming-tool-results.ts) | Streaming tool results (intermediate outputs) |

### MCP Integration

| Example | Description |
| --- | --- |
| [`examples/mcp/06-mcp-server.ts`](../examples/mcp/06-mcp-server.ts) | MCP server integration |
| [`examples/mcp/11-custom-mcp-tools.ts`](../examples/mcp/11-custom-mcp-tools.ts) | `tool()` + `createSdkMcpServer()` |

### Advanced Features

| Example | Description |
| --- | --- |
| [`examples/advanced/08-official-api-compat.ts`](../examples/advanced/08-official-api-compat.ts) | `query()` API pattern |
| [`examples/advanced/13-hooks.ts`](../examples/advanced/13-hooks.ts) | Lifecycle hooks |
| [`examples/advanced/15-openai-compat.ts`](../examples/advanced/15-openai-compat.ts) | OpenAI / DeepSeek models |
| [`examples/advanced/18-system-preset-alignment.ts`](../examples/advanced/18-system-preset-alignment.ts) | System preset alignment for consistent behavior |
| [`examples/advanced/19-web-search.ts`](../examples/advanced/19-web-search.ts) | Web search tool integration |
| [`examples/advanced/20-compact-features.ts`](../examples/advanced/20-compact-features.ts) | Compact features (context window management) |
| [`examples/advanced/32-reasoning-effort.ts`](../examples/advanced/32-reasoning-effort.ts) | Reasoning effort control |

### Web UI

| Example | Description |
| --- | --- |
| [`examples/web/server.ts`](../examples/web/server.ts) | Web chat UI for testing |

Run any example:

```bash
npx tsx examples/basic/01-simple-query.ts
npx tsx examples/agents/09-subagents.ts
npx tsx examples/streaming/34-streaming-tool-results.ts
```

Start the web UI:

```bash
npx tsx examples/web/server.ts
```

# API Reference

Top-level functions, Agent methods, configuration options, and environment variables.

## Provider Configuration

### OpenAI-compatible models

Works with OpenAI, DeepSeek, Qwen, Mistral, or any OpenAI-compatible endpoint:

```bash
export ZERONE_AGENT_API_TYPE=openai-completions
export ZERONE_AGENT_API_KEY=sk-...
export ZERONE_AGENT_BASE_URL=https://api.openai.com/v1
export ZERONE_AGENT_MODEL=gpt-4o
```

### Third-party Anthropic-compatible providers

```bash
export ZERONE_AGENT_BASE_URL=https://openrouter.ai/api
export ZERONE_AGENT_API_KEY=sk-or-...
export ZERONE_AGENT_MODEL=anthropic/claude-sonnet-4
```

## Reference

### Top-level functions

| Function                              | Description                                                    |
| ------------------------------------- | -------------------------------------------------------------- |
| `query({ prompt, options })`          | One-shot streaming query, returns `AsyncGenerator<SDKMessage>` |
| `createAgent(options)`                | Create a reusable agent with session persistence               |
| `tool(name, desc, schema, handler)`   | Create a tool with Zod schema validation                       |
| `createSdkMcpServer({ name, tools })` | Bundle tools into an in-process MCP server                     |
| `defineTool(config)`                  | Low-level tool definition helper                               |
| `getAllBaseTools()`                   | Get all 18 built-in tools                                      |
| `registerSkill(definition)`           | Register a custom skill                                        |
| `getAllSkills()`                       | Get all registered skills                                      |
| `createProvider(apiType, opts)`        | Create an LLM provider directly                                |
| `createHookRegistry(config)`          | Create a hook registry for lifecycle events                    |
| `listSessions()`                      | List persisted sessions                                        |
| `forkSession(id)`                     | Fork a session for branching                                   |

### Agent methods

| Method                          | Description                                           |
| ------------------------------- | ----------------------------------------------------- |
| `agent.query(prompt)`           | Streaming query, returns `AsyncGenerator<SDKMessage>` |
| `agent.prompt(text)`            | Blocking query, returns `Promise<QueryResult>`        |
| `agent.getMessageLog()`         | Append-only audit log of all emitted messages         |
| `agent.getMessageHistory()`     | Engine's persistent history (post-compaction view)    |
| `agent.clear()`                 | Reset session                                         |
| `agent.interrupt()`             | Abort current query                                   |
| `agent.setModel(model)`         | Change model mid-session                              |
| `agent.setPermissionMode(mode)` | Change permission mode                                |
| `agent.getApiType()`            | Get current API type                                  |
| `agent.close()`                 | Close MCP connections, persist session                |

### Options

| Option               | Type                                    | Default                | Description                                                          |
| -------------------- | --------------------------------------- | ---------------------- | -------------------------------------------------------------------- |
| `apiType`            | `string`                                | auto-detected          | `'anthropic-messages'` or `'openai-completions'`                     |
| `model`              | `string`                                | `claude-sonnet-4-6`    | LLM model ID                                                         |
| `apiKey`             | `string`                                | `ZERONE_AGENT_API_KEY` env var | API key                                                              |
| `baseURL`            | `string`                                | —                      | Custom API endpoint                                                  |
| `cwd`                | `string`                                | `process.cwd()`        | Working directory                                                    |
| `agent`             | `AgentDefinition`                       | —                      | Main agent definition: `prompt` (system prompt), `appendPrompt`, `allowedTools` / `disallowedTools`, `availableSkills`, `maxTurns` (default `10`) |
| `customTools`        | `ToolDefinition[]`                      | —                      | Custom tools, merged with the built-in tool pool                     |
| `permissionMode`     | `string`                                | `bypassPermissions`    | `default` / `acceptEdits` / `dontAsk` / `bypassPermissions` / `plan` / `auto` |
| `canUseTool`         | `function`                              | —                      | Custom permission callback                                           |
| `maxSessionTurns`    | `number`                                | —                      | Max rounds included in LLM context; older rounds trigger halved compaction |
| `maxBudgetUsd`       | `number`                                | —                      | Spending cap                                                         |
| `thinking`           | `ThinkingConfig`                        | —                      | Extended thinking (`{ type: 'adaptive' \| 'enabled' \| 'disabled', budgetTokens? }`); disabled unless set |
| `effort`             | `string`                                | —                      | Reasoning effort: `low` / `medium` / `high` / `xhigh` / `max`; not sent unless set |
| `mcpServers`         | `Record<string, McpServerConfig>`       | —                      | MCP server connections                                               |
| `subAgents`          | `Record<string, AgentDefinition>`       | —                      | Subagent definitions for Task/MultiTask                              |
| `hooks`              | `Record<string, Array<{ matcher?, hooks, timeout? }>>` | —            | Lifecycle hooks                                                      |
| `resume`             | `string`                                | —                      | Resume session by ID                                                 |
| `continue`           | `boolean`                               | `false`                | Continue most recent session                                         |
| `persistSession`     | `boolean`                               | `true`                 | Persist session to disk                                              |
| `sessionId`          | `string`                                | auto                   | Explicit session ID                                                  |
| `outputFormat`       | `{ type: 'json_schema', schema }`       | —                      | Structured output                                                    |
| `sandbox`            | `SandboxSettings`                       | —                      | Filesystem/network sandbox                                           |
| `settingSources`     | `SettingSource[]`                       | —                      | Load skills from `~/.agents/skills/` (`user`) and/or `${cwd}/.agents/skills/` (`project`) |
| `extraUserSkillDirs`     | `string[]`                          | —                      | Additional user-level skill directories (tagged `source='user'`)    |
| `extraProjectSkillDirs`  | `string[]`                          | —                      | Additional project-level skill directories (tagged `source='project'`, bypass `availableSkills`) |
| `env`                | `Record<string, string>`                | —                      | Environment variables                                                |
| `toolEnv`            | `Record<string, string \| undefined>`   | —                      | Environment variables passed to Bash/Grep subprocesses (default: merged with process.env) |
| `toolEnvInherit`     | `boolean`                               | `true`                 | When false, completely replaces process.env (use with toolEnv for fully isolated subprocess environment) |
| `abortController`    | `AbortController`                       | —                      | Cancellation controller                                              |

### MCP server transports

`mcpServers` entries are discriminated by either a `type` or `transport`
selector field (both names are accepted — `.agents/mcp.json` and provider docs
use both spellings). The SDK accepts the following values and infers the
transport when both selectors are omitted:

| Selector value               | Underlying transport                                | Required fields      |
| ---------------------------- | --------------------------------------------------- | -------------------- |
| `stdio`                      | `StdioClientTransport`                              | `command`            |
| `sse`                        | `SSEClientTransport` (legacy HTTP+SSE)              | `url`                |
| `streamable_http`            | `StreamableHTTPClientTransport` (canonical, spec)   | `url`                |
| `streamable-http`            | `StreamableHTTPClientTransport` (kebab-case alias)  | `url`                |
| `http`                       | `StreamableHTTPClientTransport` (backwards-compat)  | `url`                |
| _(omitted)_ + `command`      | `StdioClientTransport` (inferred)                   | `command`            |
| _(omitted)_ + `url`          | `StreamableHTTPClientTransport` (inferred)          | `url`                |

`streamable_http` / `streamable-http` / `http` are treated as equivalent — all
three instantiate `StreamableHTTPClientTransport`. If both `type` and
`transport` are present and normalize to different transport kinds, the SDK
fails fast with a conflict error. Unknown explicit values fail fast with a
clear error listing all supported aliases.

#### stdio working directory

`McpStdioConfig` accepts an optional `cwd` field that becomes the spawned
server's working directory. Relative `command` paths and relative entries in
`args` resolve against this directory.

| Source                                          | Resolution order |
| ----------------------------------------------- | ---------------- |
| `McpStdioConfig.cwd`                            | Wins             |
| `AgentOptions.cwd`                              | Fallback when server-level `cwd` is unset |
| _(neither set)_                                 | MCP SDK default (`process.cwd()` at spawn)   |

The Agent SDK injects `AgentOptions.cwd` into stdio server configs that do not
specify `cwd` explicitly — so a server like `{ command: 'npx', args: ['my-server'] }`
runs in the agent's workspace rather than the host process's directory. This
does not affect `sse` / Streamable HTTP transports.

### Environment variables

| Variable                 | Description                                              |
| ------------------------ | -------------------------------------------------------- |
| `ZERONE_AGENT_API_KEY`       | API key (primary)                                        |
| `ZERONE_AGENT_AUTH_TOKEN`    | Alternative auth token                                   |
| `ZERONE_AGENT_API_TYPE`      | `anthropic-messages` (default) or `openai-completions`   |
| `ZERONE_AGENT_MODEL`         | Default model override                                   |
| `ZERONE_AGENT_BASE_URL`      | Custom API endpoint                                      |
| `ZERONE_AGENT_MCP_GRACE_MS`  | MCP server shutdown grace period in ms (default: 30000)  |

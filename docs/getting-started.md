# Getting Started

This guide shows the full range of Agent SDK usage patterns. For the minimal "hello world", see the [README](../README.md#quick-start).

---

## Quick start

### One-shot query (streaming)

```typescript
import { query } from "@zerone-agent/agent-sdk";

for await (const message of query({
  prompt: "Read package.json and tell me the project name.",
  options: {
    allowedTools: ["Read", "Glob"],
    permissionMode: "bypassPermissions",
  },
})) {
  if (message.type === "assistant") {
    for (const block of message.message.content) {
      if ("text" in block) console.log(block.text);
    }
  }
}
```

### Simple blocking prompt

```typescript
import { createAgent } from "@zerone-agent/agent-sdk";

const agent = createAgent({ model: "claude-sonnet-4-6" });
const result = await agent.prompt("What files are in this project?");

console.log(result.text);
console.log(
  `Turns: ${result.num_turns}, Tokens: ${result.usage.input_tokens + result.usage.output_tokens}`,
);
```

### OpenAI / GPT models

```typescript
import { createAgent } from "@zerone-agent/agent-sdk";

const agent = createAgent({
  apiType: "openai-completions",
  model: "gpt-4o",
  apiKey: "sk-...",
  baseURL: "https://api.openai.com/v1",
});

const result = await agent.prompt("What files are in this project?");
console.log(result.text);
```

The `apiType` is auto-detected from model name — models containing `gpt-`, `o1`, `o3`, `o4`, `deepseek`, `qwen`, `yi-`, `glm`, `mistral`, `gemma` automatically use `openai-completions`.

### Multi-turn conversation

```typescript
import { createAgent } from "@zerone-agent/agent-sdk";

const agent = createAgent({
  agent: {
    description: "Multi-turn assistant",
    prompt: "You are a helpful assistant.",
    maxTurns: 5,
  },
});

const r1 = await agent.prompt(
  'Create a file /tmp/hello.txt with "Hello World"',
);
console.log(r1.text);

const r2 = await agent.prompt("Read back the file you just created");
console.log(r2.text);

console.log(`Audit log entries: ${agent.getMessageLog().length}`);
```

### Custom tools (Zod schema)

```typescript
import { z } from "zod";
import { query, tool, createSdkMcpServer } from "@zerone-agent/agent-sdk";

const getWeather = tool(
  "get_weather",
  "Get the temperature for a city",
  { city: z.string().describe("City name") },
  async ({ city }) => ({
    content: [{ type: "text", text: `${city}: 22°C, sunny` }],
  }),
);

const server = createSdkMcpServer({ name: "weather", tools: [getWeather] });

for await (const msg of query({
  prompt: "What is the weather in Tokyo?",
  options: { mcpServers: { weather: server } },
})) {
  if (msg.type === "result")
    console.log(`Done: $${msg.total_cost_usd?.toFixed(4)}`);
}
```

### Custom tools (low-level)

```typescript
import { createAgent, defineTool } from "@zerone-agent/agent-sdk";

const calculator = defineTool({
  name: "Calculator",
  description: "Evaluate a math expression",
  inputSchema: {
    type: "object",
    properties: { expression: { type: "string" } },
    required: ["expression"],
  },
  isReadOnly: true,
  async call(input) {
    const result = Function(`'use strict'; return (${input.expression})`)();
    return `${input.expression} = ${result}`;
  },
});

// customTools are merged with the built-in tool pool automatically
const agent = createAgent({ customTools: [calculator] });
const r = await agent.prompt("Calculate 2**10 * 3");
console.log(r.text);
```

### Skills

Skills are reusable prompt templates that extend agent capabilities. The SDK ships no built-in skills — register your own via `registerSkill()` or load them from the filesystem (`.agents/skills/<name>/SKILL.md`).

#### Programmatic Registration

```typescript
import {
  createAgent,
  registerSkill,
  getAllSkills,
} from "@zerone-agent/agent-sdk";

// Register a custom skill
registerSkill({
  name: "explain",
  description: "Explain a concept in simple terms",
  userInvocable: true,
  async getPrompt(args) {
    return [
      {
        type: "text",
        text: `Explain in simple terms: ${args || "Ask what to explain."}`,
      },
    ];
  },
});

console.log(`${getAllSkills().length} skills registered`);

// The model can invoke skills via the Skill tool
const agent = createAgent();
const result = await agent.prompt('Use the "explain" skill to explain git rebase');
console.log(result.text);
```

#### Filesystem Skills (Claude Code compatible)

Create `.agents/skills/my-skill/SKILL.md`:

```yaml
---
description: Analyze code quality
when-to-use: When the user asks for a code quality review
---

Analyze the codebase structure and provide recommendations.
```

Supported frontmatter fields: `description` (required), `name`, `when-to-use`, `argument-hint`, `user-invocable`, `aliases`.

Skills can be organized **flat** (one level deep) or **nested** at any depth — useful for grouping related skills:

```
.agents/skills/
├── commit/SKILL.md                # flat
├── team-a/review/SKILL.md         # nested
└── team-b/sub/deep/SKILL.md       # deeply nested
```

The skill name defaults to the **immediate parent directory** of `SKILL.md` (e.g. `team-a/review/SKILL.md` → skill name `review`), unless overridden by the `name` frontmatter field.

Load in your application:

```typescript
import { createAgent } from "@zerone-agent/agent-sdk";

const agent = createAgent({
  cwd: "/path/to/project",
  settingSources: ["project"], // Load from .agents/skills/
});

// Or load user-level skills:
const agent = createAgent({
  settingSources: ["user"], // Load from ~/.agents/skills/
});

// Or add extra user-level skill directories (scanned after the defaults):
const agent = createAgent({
  settingSources: ["user", "project"],
  extraUserSkillDirs: ["/opt/shared-skills"],         // tagged source='user'
});
```

**Setting source priority:**

- `['user']`: Load from `~/.agents/skills/`
- `['project']`: Load from `${cwd}/.agents/skills/`
- `['user', 'project']`: Load both (project skills override user skills)
- `extraUserSkillDirs`: additional user-level directories scanned after the default

> **Note**: Project-sourced skills (from `<cwd>/.agents/skills/`) **bypass the `availableSkills` allowlist** — they represent project author intent and always appear in the system prompt. User-level skills are filtered by `availableSkills` if set.

> **Migration (v1.1.5)**: The `extraProjectSkillDirs` option has been removed. Project-level skills are discovered only from `<cwd>/.agents/skills/`. Move any skill directories previously passed via `extraProjectSkillDirs` into `.agents/skills/` (e.g. as symlinks).

### Hooks (lifecycle events)

```typescript
import { createAgent, createHookRegistry } from "@zerone-agent/agent-sdk";

const hooks = createHookRegistry({
  PreToolUse: [
    {
      handler: async (input) => {
        console.log(`About to use: ${input.toolName}`);
        // Return { block: true } to prevent tool execution
      },
    },
  ],
  PostToolUse: [
    {
      handler: async (input) => {
        console.log(`Tool ${input.toolName} completed`);
      },
    },
  ],
});
```

24 lifecycle events: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `SessionStart`, `SessionEnd`, `Stop`, `SubagentStart`, `SubagentStop`, `UserPromptSubmit`, `PermissionRequest`, `PermissionDenied`, `TaskCreated`, `TaskCompleted`, `ConfigChange`, `CwdChanged`, `FileChanged`, `Notification`, `PreCompact`, `PostCompact`, `TeammateIdle`, `CronTaskCreated`, `CronTaskFired`, `CronTaskExpired`, `CronTaskDeleted`.

### MCP server integration

```typescript
import { createAgent } from "@zerone-agent/agent-sdk";

const agent = createAgent({
  mcpServers: {
    filesystem: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
    },
  },
});

const result = await agent.prompt("List files in /tmp");
console.log(result.text);
await agent.close();
```

### Subagents

```typescript
import { query } from "@zerone-agent/agent-sdk";

for await (const msg of query({
  prompt: "Use the code-reviewer agent to review src/index.ts",
  options: {
    subAgents: {
      "code-reviewer": {
        description: "Expert code reviewer",
        prompt: "Analyze code quality. Focus on security and performance.",
        allowedTools: ["Read", "Glob", "Grep"],
      },
    },
  },
})) {
  if (msg.type === "result") console.log("Done");
}
```

### Permissions

```typescript
import { query } from "@zerone-agent/agent-sdk";

// Read-only agent — can only analyze, not modify
for await (const msg of query({
  prompt: "Review the code in src/ for best practices.",
  options: {
    allowedTools: ["Read", "Glob", "Grep"],
    permissionMode: "dontAsk",
  },
})) {
  // ...
}
```

### Web UI

A built-in web chat interface is included for testing:

```bash
npx tsx examples/web/server.ts
# Open http://localhost:8081
```

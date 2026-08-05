# Agent SDK

[![npm version](https://img.shields.io/npm/v/@zerone-agent/agent-sdk)](https://www.npmjs.com/package/@zerone-agent/agent-sdk)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

[English](./README.md) | **简体中文**

开源 Agent SDK，在**进程内**运行完整的 agent loop——无需子进程或 CLI。同时支持 **Anthropic** 与 **OpenAI 兼容** API。可部署到任意环境：云、serverless、Docker、CI/CD。

## 特性

- **进程内 agent loop** —— Node 能跑的地方就能跑：云、serverless、Docker、CI/CD
- **多 provider** —— Anthropic、OpenAI / DeepSeek，或自定义 provider
- **30+ 内建工具** —— 文件 I/O、搜索、bash、web、MCP、subagents、skills
- **Streaming + blocking** —— `query()` 返回事件流，`prompt()` 返回 Promise
- **会话持久化** —— 上下文增长时自动压缩
- **权限系统** —— 按工具粒度允许/拒绝，支持 hooks 自定义策略
- **Skills + Subagents** —— 可组合的上下文内能力

## 核心概念

每次 agent 运行由 5 个核心抽象组合而成：

- **Agent** —— 会话的状态封装。持有 tool pool、MCP 连接、hooks 和历史。通过 `createAgent()` 创建。
- **QueryEngine** —— 在每次 `prompt()` / `query()` 调用上运行 agentic loop：API 请求 → 工具调用 → 重复，直到达到轮次上限或任务完成。
- **Tool** —— 模型可调用的函数。SDK 自带 20+ 内建工具（Bash、Read、Write、Edit、Glob、Grep、WebFetch……）。自定义工具用 `tool()`（Zod schema）或 `defineTool()`（底层 API）定义。
- **Provider** —— LLM 后端抽象。内建 `AnthropicProvider` 和 `OpenAIProvider`；自定义 provider 实现 `LLMProvider` 接口即可。
- **Skill** —— 可复用的 prompt 模板（与 Claude Code 兼容）。内建 5 个（`commit`、`review`、`debug`、`simplify`、`test`）；自定义 skill 从 `.agents/skills/<name>/SKILL.md` 加载。

完整的组件模型与请求流程见 [Architecture](docs/architecture.md) *(English)*。

## 安装

```bash
npm install @zerone-agent/agent-sdk
```

要求 Node.js 22 或更高版本。

设置 API key（或代码里用 `apiKey` 选项传入）：

```bash
export ANTHROPIC_API_KEY=...        # Claude
# 或
export OPENAI_API_KEY=...           # GPT / DeepSeek / Qwen / Mistral
```

其他 provider（DeepSeek、第三方 Anthropic 兼容端点、自定义 base URL）见 [Provider Configuration](docs/api.md#provider-configuration) *(English)*。

## 快速开始

**Streaming**（事件按到达顺序消费）：

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

**Blocking**（一次性返回结果）：

```typescript
import { createAgent } from "@zerone-agent/agent-sdk";

const agent = createAgent();
const result = await agent.prompt("List 3 JavaScript testing frameworks.");
console.log(result.text);
```

完整模式集合（multi-turn、custom tools、skills、hooks、MCP、subagents、permissions、web UI）见 [Getting Started](docs/getting-started.md) *(English)*。

## 文档

| 文档 | 内容 |
|------|------|
| [Getting Started](docs/getting-started.md) *(English)* | 完整 quick start，含 8 个示例模式 |
| [API Reference](docs/api.md) *(English)* | Top-level functions、Agent methods、options、env vars |
| [Built-in Tools](docs/tools.md) *(English)* | 20+ 工具 + PDF 支持详情 |
| [Architecture](docs/architecture.md) *(English)* | 组件模型与请求流程 |
| [Examples](docs/examples.md) *(English)* | 30+ 按类别组织的可运行示例 |

## 示例

浏览 [`examples/`](examples/) 目录，或查看[示例索引](docs/examples.md)按用例查找 *(English)*。

运行任意示例：

```bash
npx tsx examples/basic/01-simple-query.ts
```

## 社区

- **Issue 与功能请求**：[github.com/zerone-agents/agent-sdk/issues](https://github.com/zerone-agents/agent-sdk/issues)
- **源码仓库**：[github.com/zerone-agents/agent-sdk](https://github.com/zerone-agents/agent-sdk)

## License

MIT

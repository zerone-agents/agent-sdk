# 删除无用 Tools — 设计文档

> 创建时间：2026-08-02
> 范围：`src/tools/` 中 6 个工具文件、9 个工具的彻底清理

---

## 一、背景与目标

`src/tools/` 当前注册了 30+ 个内置工具，其中部分工具在 `examples/` 和 `tests/` 中从未被引用，属于历史演进中的遗留代码。本次清理目标：

- **移除 9 个低使用率工具**（涉及 6 个文件）
- **清理连带产生的死代码**（services 接口、测试、文档）
- **保持其余工具与公开 API 完整无损**

清理后 `src/tools/` 工具数量从 30+ 降至 21 个，所有保留工具的运行时行为不变。

---

## 二、删除清单

### 2.1 删除的工具文件（6 个）

| 文件 | 工具名 | 删除原因 |
|---|---|---|
| `src/tools/notebook-edit.ts` | `NotebookEditTool` | Jupyter 场景非通用，零引用 |
| `src/tools/send-message.ts` | `SendMessageTool` | agent 间消息传递，零示例引用 |
| `src/tools/team.ts` | `TeamCreateTool`、`TeamDeleteTool` | 团队管理，零示例引用 |
| `src/tools/worktree.ts` | `EnterWorktreeTool`、`ExitWorktreeTool` | git worktree 隔离，零示例引用 |
| `src/tools/plan.ts` | `EnterPlanModeTool`、`ExitPlanModeTool` | 计划模式，零示例引用 |
| `src/tools/lsp.ts` | `LSPTool` | 降级实现（仅 grep 回退），零示例引用 |

### 2.2 删除的测试文件（1 个）

| 文件 | 删除原因 |
|---|---|
| `src/tools/multi-agent-isolation.test.ts` | 整文件仅测试 `TeamCreateTool` / `TeamDeleteTool` / `EnterPlanModeTool` / `ExitPlanModeTool` / `SendMessageTool`，被测对象全部移除 |

### 2.3 部分删除的测试文件（1 个）

| 文件 | 删除范围 | 保留范围 |
|---|---|---|
| `src/tools/default-services.test.ts` | team / messaging / plan 相关测试用例 | askUser、toolSearch、config、webSearch 等其他测试 |

---

## 三、连带清理（关键路径）

### 3.1 注册表清理 — `src/tools/index.ts`

需要删除的内容：

| 类型 | 内容 |
|---|---|
| import 语句（6 条） | `notebook-edit.js`、`send-message.js`、`team.js`、`worktree.js`、`plan.js`、`lsp.js` |
| `ALL_TOOLS` 数组项（9 条） | `NotebookEditTool`、`SendMessageTool`、`TeamCreateTool`、`TeamDeleteTool`、`EnterWorktreeTool`、`ExitWorktreeTool`、`EnterPlanModeTool`、`ExitPlanModeTool`、`LSPTool` |
| 段落注释（4 条） | `// Worktree`、`// Planning`、`// LSP`、`// Agent`（如残留空段） |
| re-export 块（9 条） | 同 `ALL_TOOLS` |

文件顶部注释中 "30+ tools" 同步改为 "20+ tools"。

### 3.2 顶层入口清理 — `src/index.ts`

需要删除的内容：

| 类型 | 内容 |
|---|---|
| 聚合 re-export（9 条） | `NotebookEditTool`、`SendMessageTool`、`TeamCreateTool`、`TeamDeleteTool`、`EnterWorktreeTool`、`ExitWorktreeTool`、`EnterPlanModeTool`、`ExitPlanModeTool`、`LSPTool` |
| 独立 export 块（3 个） | Team 相关：`getAllTeams` / `getTeam` / `clearTeams` / `type Team`<br>Messaging 相关：`readMailbox` / `writeToMailbox` / `clearMailboxes` / `type AgentMessage`<br>Plan 相关：`isPlanModeActive` / `getCurrentPlan` |
| 段落注释 | 同步删除空段注释 |

### 3.3 Services 接口清理 — `src/tools/services.ts`

删除以下孤儿接口与字段（无消费者后变成死代码）：

| 删除项 | 行号（参考） |
|---|---|
| `import type { Team } from './team.js'` | 17 |
| `import type { AgentMessage } from './send-message.js'` | 18 |
| `TeamStorage` interface | 26–35 |
| `MessageSender` interface | 37–48 |
| `PlanState` interface | 72–82 |
| `ToolServices.team` 字段 | 103 |
| `ToolServices.messaging` 字段 | 104 |
| `ToolServices.plan` 字段 | 107 |
| `createEmptyServices()` 中 team 初始化 | 129–132 |
| `createEmptyServices()` 中 messaging 初始化（含 mailboxes Map、send/read/broadcast/clear 闭包） | 126、133–154 |
| `createEmptyServices()` 中 plan 初始化 | 159–162 |
| 头部注释中提及 team.ts / send-message.ts / plan.ts 的描述 | 7–9 |

保留：`AskUserHandler`、`ToolSearchRegistry`、`ConfigState` 及其相关字段。

### 3.4 Default Services 实现 — `src/tools/default-services.ts`

| 删除项 |
|---|
| `import type { Team } from './team.js'` |
| `import type { AgentMessage } from './send-message.js'` |
| `DefaultToolServices.team` 字段 |
| `DefaultToolServices.messaging` 字段 |
| `DefaultToolServices.plan` 字段 |
| 构造函数中 `this.team = { ... }` 初始化 |
| 构造函数中 `this.messaging = { ... }` 初始化（含 mailboxes / send / read / broadcast / clear） |
| 构造函数中 `this.plan = { ... }` 初始化 |

`TeamStorage` / `MessageSender` / `PlanState` 的 type imports 同步删除（这些接口在 `services.ts` 中已删除）。

### 3.5 文档同步

#### `README.md`

工具目录表格删除 4 行：
- `TeamCreate/Delete`
- `EnterWorktree/ExitWorktree`
- `EnterPlanMode/ExitPlanMode`
- `LSP`

工具计数（若有 "30+" 字样）同步更新。

#### `docs/tools-design-report.md`

此文件为 2026-04-22 的历史调研报告（来自初始 commit），记录了全部 34 个工具的设计分析。同步更新：

| 章节 | 修改 |
|---|---|
| 一、1.3 工具完整清单 | 计数从 34 改为 25，表格删除对应 9 行 |
| 二、2.3 子 Agent 工具隔离 | 文中提到的工具名同步更新 |
| 四、4.1 文件 I/O 工具组 | 删除 NotebookEdit 段落 |
| 四、4.3 多 Agent 工具组 | 删除 SendMessage、TeamCreate/Delete 子章节 |
| 四、4.5 Worktree 工具组 | 整章节删除 |
| 四、4.6 Plan Mode 工具组 | 整章节删除 |
| 四、4.8 LSP 工具 | 整章节删除 |
| 五、5.x 空壳工具分析 | 涉及已删除工具的内容同步删除 |
| 八、8.5 LSP 降级实现 | 整章节删除 |
| 九、结论 | 工具计数与分类描述更新 |

保留历史报告本身不删除，作为架构演进记录。

---

## 四、破坏性变更

### 4.1 公开 API 移除清单

**工具导出**（9 个）：
```
NotebookEditTool
SendMessageTool
TeamCreateTool
TeamDeleteTool
EnterWorktreeTool
ExitWorktreeTool
EnterPlanModeTool
ExitPlanModeTool
LSPTool
```

**类型导出**（5 个）：
```
Team
AgentMessage
TeamStorage
MessageSender
PlanState
```

**函数导出**（16 个）：
```
getAllTeams
getTeam
clearTeams
getAllTeamsFromStorage
getTeamFromStorage
clearTeamsInStorage
readMailbox
writeToMailbox
clearMailboxes
readMailboxFromService
writeToMailboxFromService
clearMailboxesInService
isPlanModeActive
getCurrentPlan
isPlanModeActiveInState
getCurrentPlanFromState
```

### 4.2 下游迁移注意

- 使用 `import { Team, getAllTeams } from '@zerone-agent/open-agent-sdk'` 的下游代码需自行实现团队管理逻辑
- 使用 `SendMessage` 实现 agent 间通信的下游需改用 MCP 或自定义工具
- 依赖 `EnterPlanMode`/`ExitPlanMode` 的工作流需通过 prompt engineering 实现
- `LSPTool` 的降级 grep 实现可直接迁移到下游代码（< 100 行）
- `NotebookEditTool` 的下游需自行实现 notebook 单元格编辑

### 4.3 版本号

破坏性变更，按 SDK 发布规范 bump minor 版本（当前 1.x → 1.(x+1)），release notes 标注破坏性变更章节。

---

## 五、验证步骤

实现完成后依次执行：

```bash
# 1. TypeScript 编译
npx tsc --noEmit

# 2. 全测试通过
npm test

# 3. 构建成功
npm run build

# 4. 残留引用扫描（应返回空）
grep -rn 'NotebookEdit\|SendMessage\|TeamCreate\|TeamDelete\|EnterWorktree\|ExitWorktree\|EnterPlanMode\|ExitPlanMode\|LSPTool' src/ examples/

# 5. 删除文件确认
ls src/tools/{notebook-edit,send-message,team,worktree,plan,lsp,multi-agent-isolation.test}.ts 2>&1 | grep -q "No such" && echo OK
```

---

## 六、不在本次范围

以下工具虽在 `examples/tests` 也无静态引用，但属于 LLM 运行时核心工具，**保留不动**：

- `read.ts`、`write.ts`、`bash.ts`、`glob.ts`、`grep.ts`（核心 I/O）
- `ask-user.ts`、`config.ts`、`tool-search.ts`、`mcp-resource.ts`、`skill.ts`（功能型工具）

如需进一步精简，单独提案处理。

# 删除无用 Tools 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从 `src/tools/` 删除 9 个无用工具（涉及 6 个文件），并清理所有连带依赖（services 接口、注册表、测试、文档），保持构建绿色。

**Architecture:** 按 "先清理依赖、后删除文件" 的顺序执行：先删/改测试 → 清理 services 类型与实现 → 更新两级注册表（`src/tools/index.ts` 与 `src/index.ts`）→ 删除工具文件本身 → 同步文档 → 最终验证。每个任务结束都通过 `tsc --noEmit` + `npm test` 保证主分支始终可编译可测试。

**Tech Stack:** TypeScript（NodeNext 模块）、vitest 测试框架、ESM（`.js` 后缀导入）。

## Global Constraints

- 严格遵循 ESM `.js` 后缀 import 规范（即使是同目录文件）。
- 不修改与本次无关的工具文件（保留 `read.ts`/`write.ts`/`bash.ts`/`glob.ts`/`grep.ts`/`ask-user.ts`/`config.ts`/`tool-search.ts`/`mcp-resource.ts`/`skill.ts`）。
- 删除每个文件后必须确认无残留引用（任务 6 的 grep 校验是硬门槛）。
- 提交信息使用 conventional commits 格式，破坏性变更在 commit body 中标 `BREAKING CHANGE:`。
- 中文 release notes 与文档约定（见仓库 memory）。
- 不引入新依赖，不修改 `package.json`。

**Spec 参考：** `docs/superpowers/specs/2026-08-02-delete-unused-tools-design.md`

---

## File Structure

| 文件 | 操作 | 任务 |
|---|---|---|
| `src/tools/multi-agent-isolation.test.ts` | 删除 | Task 1 |
| `src/tools/default-services.test.ts` | 修改（删除 team/messaging/plan 相关用例） | Task 1 |
| `src/tools/services.ts` | 修改（删除 3 个 interface、3 个字段、3 块初始化、2 个 import） | Task 2 |
| `src/tools/default-services.ts` | 修改（删除 3 个字段、3 块初始化、2 个 import） | Task 2 |
| `src/tools/index.ts` | 修改（删 6 import、9 个 ALL_TOOLS 项、9 个 re-export） | Task 3 |
| `src/index.ts` | 修改（删 9 个聚合 re-export、3 个独立 export 块、2 个 type export） | Task 3 |
| `src/tools/notebook-edit.ts` | 删除 | Task 4 |
| `src/tools/send-message.ts` | 删除 | Task 4 |
| `src/tools/team.ts` | 删除 | Task 4 |
| `src/tools/worktree.ts` | 删除 | Task 4 |
| `src/tools/plan.ts` | 删除 | Task 4 |
| `src/tools/lsp.ts` | 删除 | Task 4 |
| `README.md` | 修改（删工具目录 6 行） | Task 5 |
| `docs/tools-design-report.md` | 修改（更新计数 + 删/改章节） | Task 5 |

---

## Task 1: 清理测试文件

**Files:**
- Delete: `src/tools/multi-agent-isolation.test.ts`
- Modify: `src/tools/default-services.test.ts`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces: 干净的测试套件，不引用将被删除的 tool 文件，不引用将被移除的 `DefaultToolServices.team` / `.messaging` / `.plan` 字段。

- [ ] **Step 1: 删除 `src/tools/multi-agent-isolation.test.ts`**

整个文件删除——它只测试 `TeamCreateTool` / `TeamDeleteTool` / `EnterPlanModeTool` / `ExitPlanModeTool` / `SendMessageTool`，被测对象将全部移除。

```bash
rm src/tools/multi-agent-isolation.test.ts
```

- [ ] **Step 2: 修改 `src/tools/default-services.test.ts`**

删除以下 5 个 `it(...)` 测试用例（保留文件中其他所有用例）：

1. `creates separate team storage per instance`（约第 10–28 行）
2. `creates separate messaging per instance`（约第 30–51 行）
3. `creates separate messaging broadcast per instance`（约第 53–84 行）
4. `creates separate messaging clear per instance`（约第 86–104 行）
5. `creates separate plan state per instance`（约第 144–159 行）

修改 `initializes with correct default values` 测试（约第 179–189 行），删除对 `team`/`messaging`/`plan` 字段的断言，只保留：

```typescript
it('initializes with correct default values', () => {
  const services = new DefaultToolServices()

  expect(services.askUser).toBeNull()
  expect(services.toolSearch.deferredTools).toHaveLength(0)
  expect(services.config.size).toBe(0)
})
```

删除 `messaging read returns empty for unknown agent` 测试（约第 191–194 行）——它依赖已删除的 `messaging` 字段。

保留的用例：
- `creates separate askUser handler per instance`
- `creates separate tool search registry per instance`
- `creates separate config storage per instance`
- 修改后的 `initializes with correct default values`

- [ ] **Step 3: 运行测试，验证通过**

```bash
npm test
```

预期：所有剩余测试通过。失败则回退本次修改。

- [ ] **Step 4: 提交**

```bash
git add src/tools/multi-agent-isolation.test.ts src/tools/default-services.test.ts
git commit -m "refactor(tools): drop tests for tools slated for removal

Remove multi-agent-isolation.test.ts (only tested Team/Plan/SendMessage).
Trim default-services.test.ts to drop team/messaging/plan test cases.

BREAKING CHANGE: no public API change yet; preparation for tool removal."
```

---

## Task 2: 清理 services 类型与 default 实现

**Files:**
- Modify: `src/tools/services.ts`
- Modify: `src/tools/default-services.ts`

**Interfaces:**
- Consumes: Task 1 已删除引用这些字段的测试。
- Produces: `ToolServices` 与 `DefaultToolServices` 不再包含 `team` / `messaging` / `plan` 字段。后续任务可安全删除 `team.ts` / `send-message.ts` / `plan.ts`。

- [ ] **Step 1: 修改 `src/tools/services.ts`**

按下列清单删除（行号供参考，以实际为准）：

**删除 import：**
- 第 17 行：`import type { Team } from './team.js'`
- 第 18 行：`import type { AgentMessage } from './send-message.js'`

**删除 3 个 interface 定义：**
- `TeamStorage`（约第 25–35 行，连同上方注释）
- `MessageSender`（约第 37–48 行，连同上方注释）
- `PlanState`（约第 72–82 行，连同上方注释）

**修改 `ToolServices` interface（约第 102–111 行）：**

删除 3 个字段，保留其他字段：

```typescript
export interface ToolServices {
  askUser: AskUserHandler | null
  toolSearch: ToolSearchRegistry
  config: ConfigState
  /** Optional WebSearch provider configuration; absent = anonymous Exa → Parallel default. */
  webSearch?: WebSearchConfig
}
```

**修改 `createEmptyServices()`（约第 125–165 行）：**

```typescript
export function createEmptyServices(): ToolServices {
  return {
    askUser: null,
    toolSearch: {
      deferredTools: [],
    },
    config: new Map<string, unknown>(),
  }
}
```

删除原函数中的 `mailboxes` Map 局部变量、`team` / `messaging` / `plan` 三块初始化。

**修改文件头部注释（约第 7–9 行）：**

把 `Currently, 6 tool modules (team.ts, send-message.ts, ask-user.ts, tool-search.ts, plan.ts, config.ts) ...` 改为：

```
 * Currently, 3 tool modules (ask-user.ts, tool-search.ts, config.ts) store
 * state in module-level variables. When multiple Agent instances coexist,
 * these globals are overwritten. ToolServices moves that state into
 * per-agent containers.
```

- [ ] **Step 2: 修改 `src/tools/default-services.ts`**

**删除 import：**
- `import type { Team } from './team.js'`
- `import type { AgentMessage } from './send-message.js'`
- 从 `./services.js` 的 import 中删除 `TeamStorage`、`MessageSender`、`PlanState`（保留 `ToolServices`、`AskUserHandler`、`ToolSearchRegistry`、`ConfigState`）。

**删除 3 个 class 字段：**
- `team: TeamStorage`
- `messaging: MessageSender`
- `plan: PlanState`

**删除 constructor 中 3 块初始化：**
- `this.team = { teams: new Map<string, Team>(), counter: 0 }`
- `this.messaging = { ... }` 整块（含 mailboxes Map、send/read/broadcast/clear 闭包）
- `this.plan = { active: false, currentPlan: null }`

保留 `askUser`、`toolSearch`、`config` 字段及其初始化，保留 `webSearch?` 可选字段（如果有）。

修改后的类应类似：

```typescript
export class DefaultToolServices implements ToolServices {
  askUser: AskUserHandler | null
  toolSearch: ToolSearchRegistry
  config: ConfigState
  /** Optional WebSearch provider configuration; absent = anonymous Exa → Parallel default. */
  webSearch?: WebSearchConfig

  constructor() {
    this.askUser = null
    this.toolSearch = {
      deferredTools: [],
    }
    this.config = new Map<string, unknown>()
  }
}
```

- [ ] **Step 3: TypeScript 编译校验**

```bash
npx tsc --noEmit
```

预期：编译通过。如果报错说某处仍引用 `services.team` / `.messaging` / `.plan`，定位并删除引用后重试。

- [ ] **Step 4: 运行测试**

```bash
npm test
```

预期：所有测试通过。

- [ ] **Step 5: 提交**

```bash
git add src/tools/services.ts src/tools/default-services.ts
git commit -m "refactor(tools): remove orphaned team/messaging/plan services

These service fields existed solely to back the team/send-message/plan
tool modules, which are being removed. Drop the interfaces, the
ToolServices fields, and the DefaultToolServices initializers.

BREAKING CHANGE: ToolServices no longer has team/messaging/plan fields.
Consumers reading these fields must migrate."
```

---

## Task 3: 更新两级注册表

**Files:**
- Modify: `src/tools/index.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: Task 2 已清理 services，不再有对被删 tool 的隐式类型依赖。
- Produces: 注册表与顶层 SDK 入口不再导出/导入将被删除的 6 个文件。后续任务可安全删除文件。

- [ ] **Step 1: 修改 `src/tools/index.ts`**

**删除 6 个 import 语句：**

```typescript
import { NotebookEditTool } from './notebook-edit.js'
import { SendMessageTool } from './send-message.js'
import { TeamCreateTool, TeamDeleteTool } from './team.js'
import { EnterWorktreeTool, ExitWorktreeTool } from './worktree.js'
import { EnterPlanModeTool, ExitPlanModeTool } from './plan.js'
import { LSPTool } from './lsp.js'
```

**从 `ALL_TOOLS` 数组中删除 9 个项：**

```typescript
NotebookEditTool,
SendMessageTool,
TeamCreateTool,
TeamDeleteTool,
EnterWorktreeTool,
ExitWorktreeTool,
EnterPlanModeTool,
ExitPlanModeTool,
LSPTool,
```

**删除空段注释（如残留）：**
- `// Worktree`
- `// Planning`
- `// LSP`

**从底部 re-export 块中删除 9 个项**（同 `ALL_TOOLS` 列表）。

**修改文件顶部注释：**

把 `30+ tools covering file I/O, execution, search, web, agents,` 改为 `20+ tools covering file I/O, execution, search, web, agents,`，并把 `const ALL_TOOLS: ToolDefinition[]` 上方注释 `All built-in tools (30+).` 改为 `All built-in tools (20+).`。

- [ ] **Step 2: 修改 `src/index.ts`**

**修改第 76 行附近注释：**

```typescript
// --------------------------------------------------------------------------
// Tool System (30+ tools)
// --------------------------------------------------------------------------
```

改为：

```typescript
// --------------------------------------------------------------------------
// Tool System (20+ tools)
// --------------------------------------------------------------------------
```

**从聚合 export 块（约第 79–144 行）中删除 9 项：**

```typescript
NotebookEditTool,
SendMessageTool,
TeamCreateTool,
TeamDeleteTool,
EnterWorktreeTool,
ExitWorktreeTool,
EnterPlanModeTool,
ExitPlanModeTool,
LSPTool,
```

同时删除空段注释：`// Worktree`、`// Planning`、`// LSP`、`// Agent`（如果 Agent 段下不再有任何工具）。

**删除 3 个独立 export 块（约第 353–370 行）：**

```typescript
export {
  getAllTeams,
  getTeam,
  clearTeams,
} from './tools/team.js'
export type { Team } from './tools/team.js'

export {
  readMailbox,
  writeToMailbox,
  clearMailboxes,
} from './tools/send-message.js'
export type { AgentMessage } from './tools/send-message.js'

export {
  isPlanModeActive,
  getCurrentPlan,
} from './tools/plan.js'
```

保留紧随其后的 `setQuestionHandler` / `clearQuestionHandler` / `setDeferredTools` 等 export 块。

- [ ] **Step 3: TypeScript 编译校验**

```bash
npx tsc --noEmit
```

预期：编译通过。

- [ ] **Step 4: 运行测试**

```bash
npm test
```

预期：所有测试通过。

- [ ] **Step 5: 提交**

```bash
git add src/tools/index.ts src/index.ts
git commit -m "refactor(tools): unregister 9 unused tools from registry

Remove imports and re-exports of NotebookEdit/SendMessage/Team/
Worktree/Plan/LSP from src/tools/index.ts and src/index.ts.

BREAKING CHANGE: 9 tools and their helper exports are no longer
reachable from the SDK entry. Tool files themselves are deleted in
the next commit."
```

---

## Task 4: 删除 6 个工具文件

**Files:**
- Delete: `src/tools/notebook-edit.ts`
- Delete: `src/tools/send-message.ts`
- Delete: `src/tools/team.ts`
- Delete: `src/tools/worktree.ts`
- Delete: `src/tools/plan.ts`
- Delete: `src/tools/lsp.ts`

**Interfaces:**
- Consumes: Task 1–3 已删除所有静态引用，编译已不依赖这些文件。
- Produces: 文件系统层面不再存在这些工具的源码。

- [ ] **Step 1: 删除 6 个文件**

```bash
rm src/tools/notebook-edit.ts \
   src/tools/send-message.ts \
   src/tools/team.ts \
   src/tools/worktree.ts \
   src/tools/plan.ts \
   src/tools/lsp.ts
```

- [ ] **Step 2: TypeScript 编译校验**

```bash
npx tsc --noEmit
```

预期：编译通过。如果有报错，说明 Task 3 遗漏了某处 import，回去补漏。

- [ ] **Step 3: 残留引用扫描**

```bash
grep -rn 'notebook-edit\|send-message\|\bteam\.js\|worktree\.js\|plan\.js\|lsp\.js\|NotebookEdit\|SendMessageTool\|TeamCreateTool\|TeamDeleteTool\|EnterWorktreeTool\|ExitWorktreeTool\|EnterPlanModeTool\|ExitPlanModeTool\|LSPTool' src/ examples/
```

预期：无匹配（或仅匹配无关的字符串，如示例中的 `SnapshotEngine({ worktree: ... })` —— 那是 SnapshotEngine 的选项，不相关）。

如出现真实残留引用（如某个 tool 文件内部还在 import `'./team.js'`），回到 Task 3 修复。

- [ ] **Step 4: 运行测试**

```bash
npm test
```

预期：所有测试通过。

- [ ] **Step 5: 构建校验**

```bash
npm run build
```

预期：构建成功，`dist/` 目录生成。

- [ ] **Step 6: 提交**

```bash
git add -A src/tools/
git commit -m "refactor(tools)!: delete 6 unused tool modules

Remove the following tool files entirely:
- notebook-edit.ts (NotebookEditTool)
- send-message.ts (SendMessageTool, mailbox helpers, AgentMessage type)
- team.ts (TeamCreateTool, TeamDeleteTool, Team type, team helpers)
- worktree.ts (EnterWorktreeTool, ExitWorktreeTool)
- plan.ts (EnterPlanModeTool, ExitPlanModeTool, plan-mode helpers)
- lsp.ts (LSPTool)

These tools had zero references in examples/ or tests/ and covered
niche/legacy use cases. The SDK now ships 21 built-in tools.

BREAKING CHANGE: NotebookEdit/SendMessage/Team/Worktree/Plan/LSP tools
removed. See docs/superpowers/specs/2026-08-02-delete-unused-tools-design.md
for migration notes."
```

---

## Task 5: 同步文档

**Files:**
- Modify: `README.md`
- Modify: `docs/tools-design-report.md`

**Interfaces:**
- Consumes: Task 4 已完成代码层删除。
- Produces: 公开文档与代码状态一致。

- [ ] **Step 1: 修改 `README.md`**

从工具目录表格（约第 411–436 行）中删除以下 6 行：

```
| **NotebookEdit**                           | Edit Jupyter notebook cells                  |
| **TeamCreate/Delete**                      | Multi-agent team coordination                |
| **SendMessage**                            | Inter-agent messaging                        |
| **EnterWorktree/ExitWorktree**             | Git worktree isolation                       |
| **EnterPlanMode/ExitPlanMode**             | Structured planning workflow                 |
| **LSP**                                    | Language Server Protocol (code intelligence) |
```

保留表格中其他所有行。表格上下文字与格式不变。

如果 README 中其他位置有提及这些工具名（用 `grep -n 'NotebookEdit\|SendMessage\|TeamCreate\|TeamDelete\|EnterWorktree\|ExitWorktree\|EnterPlanMode\|ExitPlanMode\|LSP' README.md` 检查），同步更新或删除。

- [ ] **Step 2: 修改 `docs/tools-design-report.md`**

**修改"一、1.3 工具完整清单"（约第 37–69 行）：**

- 标题 `### 1.3 工具完整清单（34 个）` 改为 `### 1.3 工具完整清单（25 个）`
- 表格中删除以下 9 行（涉及 6 个分类）：
  - NotebookEdit 行
  - SendMessage 行
  - TeamCreate 行
  - TeamDelete 行
  - EnterWorktree 行
  - ExitWorktree 行
  - EnterPlanMode 行
  - ExitPlanMode 行
  - LSP 行
- 删除空分类标题：`**Worktree**`、`**规划**`、`**LSP**`（如该分类下已无工具）

**修改"1.2 工具生命周期"图（约第 27–35 行）：**

把 `ALL_TOOLS (34个)` 改为 `ALL_TOOLS (25个)`。

**修改"四、各工具详细分析"：**

- 4.1 文件 I/O 工具组：删除 `**NotebookEdit**：Jupyter Notebook 单元格编辑。写操作。`（约第 250 行）
- 4.3 多 Agent 工具组：删除 `#### SendMessage（...）` 整个子章节（约第 273–284 行）
- 4.3 多 Agent 工具组：删除 `#### TeamCreate / TeamDelete（...）` 整个子章节（约第 286–301 行）
- 4.5 Worktree 工具组：整个章节删除（约第 315–322 行）
- 4.6 Plan Mode 工具组：整个章节删除（约第 324–331 行）
- 4.8 LSP 工具：整个章节删除（约第 340–352 行）
- 后续章节编号顺延（4.7 → 4.7 用户交互保持不变，原 4.9 Config → 4.8 Config，原 4.10 Skill → 4.9 Skill）

**修改"五、空壳工具分析"（约第 368–426 行）：**

- 删除 5.x 中涉及 TeamCreate/Delete、SendMessage、Worktree、Plan、LSP、NotebookEdit 的内容（如果有）
- 保留 ToolSearch / MCP Resources / Cron / RemoteTrigger 的空壳分析（这些工具未删除）

**修改"八、设计问题与改进建议"：**

- 删除 8.5 LSP 降级实现未告知 LLM 整章节（约第 558–561 行）
- 后续章节编号顺延（8.6 → 8.5）

**修改"九、结论"（约第 571–579 行）：**

更新工具分类描述，把已删除的工具从分类中移除：

```
1. **核心工具**（文件 I/O、Web、搜索）——功能完整，可直接使用
2. **多 Agent 协作**（Agent、Task）——框架完整，适合基础协作场景
3. **扩展工具**（Cron、MCP Resources、ToolSearch、RemoteTrigger）——接口设计合理，但**核心逻辑未接入**，均为架构占位
```

（原第 2 项删除了 SendMessage 和 Team；原第 3 项删除了 LSP）

**在文档顶部"调研时间"下方加一行：**

```
> 更新时间：2026-08-02（移除 NotebookEdit/SendMessage/Team/Worktree/Plan/LSP 工具）
```

- [ ] **Step 3: 提交**

```bash
git add README.md docs/tools-design-report.md
git commit -m "docs: sync tool catalogue after removal

README: drop 6 rows from tool table (NotebookEdit/SendMessage/Team/
Worktree/Plan/LSP).

tools-design-report: update tool counts (34→25), delete sections for
removed tools, add update timestamp."
```

---

## Task 6: 最终验证

**Files:** 无修改，仅验证。

- [ ] **Step 1: TypeScript 编译**

```bash
npx tsc --noEmit
```

预期：0 error。

- [ ] **Step 2: 全测试套件**

```bash
npm test
```

预期：所有测试通过。

- [ ] **Step 3: 构建**

```bash
npm run build
```

预期：构建成功，无 warning（或仅有已知的、与本次无关的 warning）。

- [ ] **Step 4: 残留引用终检**

```bash
grep -rn 'NotebookEdit\|SendMessage\|TeamCreate\|TeamDelete\|EnterWorktree\|ExitWorktree\|EnterPlanMode\|ExitPlanMode\|LSPTool' src/ examples/ 2>/dev/null
```

预期：无匹配。

```bash
ls src/tools/{notebook-edit,send-message,team,worktree,plan,lsp,multi-agent-isolation.test}.ts 2>&1
```

预期：`No such file or directory` × 7。

- [ ] **Step 5: 验证报告**

把上述 4 步的实际输出贴到 PR 描述或 release notes 中，作为破坏性变更的验证证据。

无需 commit（本任务无文件改动）。

---

## Self-Review

**Spec coverage check:**

- Spec §2.1 删除 6 个工具文件 → Task 4 ✓
- Spec §2.2 删除 multi-agent-isolation.test.ts → Task 1 ✓
- Spec §2.3 default-services.test.ts 部分删除 → Task 1 ✓
- Spec §3.1 注册表 src/tools/index.ts → Task 3 ✓
- Spec §3.2 顶层 src/index.ts → Task 3 ✓
- Spec §3.3 services.ts 清理 → Task 2 ✓
- Spec §3.4 default-services.ts 清理 → Task 2 ✓
- Spec §3.5 README.md → Task 5 ✓
- Spec §3.5 docs/tools-design-report.md → Task 5 ✓
- Spec §5 验证步骤 → Task 6 ✓

**Placeholder scan:** 无 TBD/TODO；每步都给了具体行号或完整代码块。

**Type consistency:** `ToolServices` / `DefaultToolServices` 修改后字段一致（askUser / toolSearch / config / webSearch?）；测试中保留的字段与修改后的类一致。

**Order safety:** 任务顺序保证每个 commit 后 `tsc --noEmit` + `npm test` 都能通过：
- Task 1：测试文件先改，不影响编译。
- Task 2：services 与 default-services 同步修改，互相一致。
- Task 3：注册表不再 import 将被删的文件，编译不再依赖它们。
- Task 4：此时文件已无引用，删除安全。
- Task 5：仅文档。
- Task 6：纯验证。

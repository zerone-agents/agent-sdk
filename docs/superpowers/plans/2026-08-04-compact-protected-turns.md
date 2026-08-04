# Compact Protected Turns 2 → 6 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将自动压缩/修剪保留的最近用户轮次从 2 增加到 6，让压缩后保留更多原文信息。

**Architecture:** 单一常量 `PRUNE_PROTECTED_TURNS`（`src/utils/compact.ts`）被 `compactConversationWithProtectedTail` 和 `pruneMessages` 共用，只改常量值，行为保持一致。

**Tech Stack:** TypeScript, Vitest

## Global Constraints

- 只修改 `PRUNE_PROTECTED_TURNS` 的值，不拆分常量、不加配置项
- 验证命令：`npm test`（vitest run）、`npm run typecheck`

**Spec:** `docs/superpowers/specs/2026-08-04-compact-protected-turns-design.md`

**背景调研结论：** 全仓库没有测试直接断言 `PRUNE_PROTECTED_TURNS` 的当前值或"保护最近 2 轮"的行为（`src/utils/body-size.test.ts` 只用 `microCompactMessages`，该函数不读此常量）。因此无需更新测试，但改完后必须跑全量测试确认无隐藏依赖。

---

### Task 1: 将 PRUNE_PROTECTED_TURNS 改为 6

**Files:**
- Modify: `src/utils/compact.ts:18`

**Interfaces:**
- Consumes: 无
- Produces: `export const PRUNE_PROTECTED_TURNS = 6`（导出签名不变，`src/agent.ts`、`src/engine.ts`、`src/index.ts` 的消费方不受影响）

- [ ] **Step 1: 修改常量值**

`src/utils/compact.ts` 第 18 行：

```ts
// 改前
export const PRUNE_PROTECTED_TURNS = 2
// 改后
export const PRUNE_PROTECTED_TURNS = 6
```

- [ ] **Step 2: 跑全量测试**

Run: `npm test`
Expected: 全部通过（背景调研确认无测试依赖旧值 2；若有意外失败，检查是否硬编码了轮数假设并按新行为更新）

- [ ] **Step 3: 类型检查**

Run: `npm run typecheck`
Expected: 无错误

- [ ] **Step 4: Commit**

```bash
git add src/utils/compact.ts
git commit -m "feat: increase compact protected turns from 2 to 6"
```

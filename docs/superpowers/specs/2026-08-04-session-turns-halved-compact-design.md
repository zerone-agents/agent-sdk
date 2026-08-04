# maxSessionTurns 折半压缩（复用现有压缩流程）

日期：2026-08-04

## 背景

`maxSessionTurns` 目前通过 `truncateToLastNTurns` 在每轮 API 调用前对 `apiMessages` 硬截断：超出 N 轮的旧历史被静默丢弃，信息彻底丢失。本设计将其改为"折半压缩"：超限时把旧的一半历史用 LLM 摘要保留，最近一半原文保留，并改写引擎持久历史。

压缩完全复用现有 `compactConversationWithProtectedTail` 流程，只泛化一个参数。

## 设计

### 1. 泛化 `compactConversationWithProtectedTail`（`src/utils/compact.ts`）

新增可选参数 `protectedTurns: number = PRUNE_PROTECTED_TURNS`。现有调用方（auto-compact、手动 compact）不传参，行为不变。内部逻辑不变：head 经 `compactConversationStream` 摘要为 user/assistant 消息对，tail 原文保留，拼回 `[摘要对, ...tail, lastMessage]`；最后一条消息始终保护。

### 2. engine 接入（`src/engine.ts`）

- 在 agentic loop 每轮开头（auto-compact 检查之后）统计 `this.messages` 的 fresh user 轮数（复用 `session-turns.ts` 的边界逻辑；摘要消息对的 user 消息计 1 轮）。
- 轮数 > `maxSessionTurns` 时，走与 auto-compact 相同的压缩路径（`compactConversationWithProtectedTail`，`protectedTurns = maxSessionTurns / 2`），yield 相同的 `SDKCompactMessage` 事件流，结果改写 `this.messages`。
- 压缩失败时（现有流程失败原样返回消息），降级为 `truncateToLastNTurns(this.messages, maxSessionTurns)` 硬截断，保证上下文必然收敛。
- 移除原每轮对 `apiMessages` 的 `truncateToLastNTurns` 调用（压缩后持久历史已在限内）。`truncateToLastNTurns` 保留导出，并用于上述降级路径。

### 3. 行为示例

`maxSessionTurns = 100`：第 100 轮触发压缩 → 最旧约 50 轮摘要成 1 条消息对，最近 50 轮原文保留 → 新状态约 51 轮 → 再增长约 49 轮后再次触发。

## 不做的事（YAGNI）

- 不做增量摘要缓存
- 不加新的配置项（复用 `maxSessionTurns`）
- 不改变 auto-compact 的触发阈值与行为

## 影响与代价

- 触发压缩的当轮多一次 LLM 摘要调用（与 auto-compact 相同性质）。
- 旧轮次原文不可恢复，但保留了摘要（优于现状的直接丢弃）。
- 压缩改写持久历史，对 session resume 等下游可见。

## 测试

- `compact` 相关测试：`protectedTurns` 缺省时行为不变；指定值时 tail 保留轮数正确。
- engine 集成测试（mock provider）：超限触发压缩并改写持久历史、事件流透出、摘要失败时降级为硬截断。
- 现有 `session-turns.test.ts` 不受影响（函数保留，行为不变）。

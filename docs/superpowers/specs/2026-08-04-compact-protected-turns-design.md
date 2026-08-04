# 自动压缩保留更多轮次（Protected Turns 2 → 6）

日期：2026-08-04

## 背景

`src/utils/compact.ts` 中的 `PRUNE_PROTECTED_TURNS = 2` 控制两处行为：

1. `compactConversationWithProtectedTail`：自动/手动压缩时，最近 N 个用户轮次原文保留，更早的历史交给 LLM 摘要。
2. `pruneMessages`：修剪超大 tool result（> 20K 字符替换为占位符）时，最近 N 轮受保护不被清空。

现状 N=2，压缩后保留的原文上下文偏少，用户希望保留更多。

## 设计

将 `PRUNE_PROTECTED_TURNS` 从 `2` 改为 `6`。两处行为共用这个常量，保持一致（与现状相同），不拆分。

不做的事（YAGNI）：

- 不做可配置选项
- 不引入按 token 预算保护尾部的逻辑
- 不改变摘要 prompt、压缩阈值等其他行为

## 影响

- 压缩后上下文更大，信息保留更完整；代价是再次达到压缩阈值的间隔略缩短。
- `pruneMessages` 的保护范围同步扩大，旧的大 tool result 会保留更久。

## 测试

- 搜索依赖 `PRUNE_PROTECTED_TURNS` 当前值（2）的测试断言并更新（grep `PRUNE_PROTECTED_TURNS`、`prune`、`compactConversationWithProtectedTail` 相关测试）。
- 运行现有 compact 相关测试套件确认通过。

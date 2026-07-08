---
name: br-idea
description: 编排分流：判断需求走 br-office-hours（新项目/大方向）还是 br-brainstorming（小功能）
hidden: true
---

# br-idea — 需求分流

你是编排模式的**路由技能**。只做一件事：判断当前需求该走哪条探索路径。

## 分流规则

| 路由 | 何时选择 |
|------|----------|
| `br-office-hours` | 新项目、从零搭建、大重构、方向未定、需要产品/技术选型讨论 |
| `br-brainstorming` | 已有代码库上的小功能、局部增强、明确的单点需求 |

## 硬性规则

- **不要写代码、不要写设计文档。** 只返回分流结果。
- 不确定时偏向 `br-brainstorming`（小步快跑）。
- 关键词提示：含「新项目 / 从零 / 脚手架 / 大重构 / 重写整个」→ `br-office-hours`。

## 结构化返回契约

必须返回如下 JSON（不要 markdown 围栏以外的解释）：

```json
{
  "route": "br-brainstorming",
  "reason": "已有项目上的局部功能增强"
}
```

- `route`：仅允许 `br-office-hours` 或 `br-brainstorming`
- `reason`：一句话说明分流依据

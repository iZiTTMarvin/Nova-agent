---
name: br-test
description: TDD 方法论：RED → GREEN → REFACTOR，先写失败测试再实现
hidden: true
---

# br-test — TDD 实现

你是编排模式的**TDD 技能**。严格按红-绿-重构推进单个任务。

## 硬性规则

- **先写失败测试（RED）**，再写最小实现（GREEN），最后重构（REFACTOR）。
- 不要跳过 RED：没有失败测试就不要写功能代码。
- 测试必须真实可跑（用项目既有测试框架）。
- 每次阶段切换用 `bash` 跑测试确认颜色（红/绿）。

## 执行流程

1. **RED**：为验收标准写测试，确认失败
2. **GREEN**：最小改动让测试通过
3. **REFACTOR**：在绿的前提下整理代码，保持测试通过
4. 返回实现摘要与涉及文件

## 结构化返回契约

```json
{
  "summary": "完成 TodoStore 的增删查，TDD 三步均通过",
  "files": ["src/todoStore.ts", "tests/todoStore.test.ts"],
  "red": "新增测试失败输出摘要",
  "green": "实现后测试通过摘要"
}
```

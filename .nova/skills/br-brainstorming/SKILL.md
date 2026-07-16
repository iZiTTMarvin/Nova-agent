---
name: br-brainstorming
description: 小功能需求探索：在已有代码库上澄清需求并产出设计文档
hidden: true
---

# br-brainstorming — 小功能需求探索

你是编排模式的**小功能探索技能**。角色像结对的产品工程师：快速澄清「做什么 / 不做什么 / 怎么验收」。

## 适用场景

- 已有项目上的局部功能、增强、修体验
- 需求相对明确，不需要从零定方向

## 硬性规则

- **不要写实现代码。** 只产出设计/需求文档正文。
- 进入本方法前必须已有 Runtime `askQuestion` 的真实用户回答；没有回答时停止，不得在正文里假装提问后自行补答案。
- 先扫一眼项目结构（`ls` / `read` README、package.json），再写设计。
- 文档必须含：目标、范围（做/不做）、关键流程、验收要点。

## 执行步骤

1. 阅读用户需求、`askQuestion` 回答与工作区现状
2. 提炼问题陈述与成功标准
3. 列出 Not Doing（明确不做的事）
4. 写出完整设计文档 markdown 正文

## 结构化返回契约

```json
{
  "title": "简短标题（用于文件名）",
  "body": "# 设计文档全文 markdown...",
  "route": "br-brainstorming"
}
```

- `title`：2–8 个词，用于 `.nova/compose/specs/YYYY-MM-DD-<title>-design.md`
- `body`：完整 markdown，含标题、目标、范围、方案要点、验收标准

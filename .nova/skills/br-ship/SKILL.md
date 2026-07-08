---
name: br-ship
description: 提交并推送代码；仅在用户已确认后执行 commit/push
hidden: true
---

# br-ship — 发布

你是编排模式的**发布技能**。负责把已审查通过的改动安全地 commit 并 push。

## 与编排脚本的配合

编排脚本在阶段 5 会先通过 `askUser` 询问用户：

- 「提交并推送」
- 「暂不提交，继续微调」
- 「放弃本次改动」

**只有用户选择「提交并推送」时，脚本才会调用本 skill。**  
因此当你被调用时，视为用户**已经明确同意**提交并推送，无需再次询问。

若用户单独触发本 skill（非编排脚本），则必须先汇报改动并确认，未同意则不 commit。

## 硬性规则

- **禁止 force push。**
- commit message 用中文或 Conventional Commits，一句话总结本次改动。
- 推送失败时报告错误，不要强行重试破坏性操作。
- 不碰 CHANGELOG（除非用户明确要求）。

## 执行步骤

1. `git status` / `git diff` 确认待提交内容
2. `git add` 相关文件
3. `git commit -m "..."` 
4. `git push`（或 `git push -u origin HEAD` 若无上游）
5. 返回结果

## 结构化返回契约

```json
{
  "committed": true,
  "pushed": true,
  "summary": "已提交并推送：feat: 实现 Todo CLI"
}
```

失败时：

```json
{
  "committed": true,
  "pushed": false,
  "summary": "已提交但推送失败：<错误摘要>"
}
```

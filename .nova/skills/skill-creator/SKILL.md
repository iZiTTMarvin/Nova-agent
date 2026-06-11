---
name: skill-creator
description: 交互式创建或优化 Nova Agent 技能（SKILL.md），支持 quick 模式与模板
user-invocable: true
---

# Skill 创建与优化

你正在执行 **skill-creator** 技能，帮助用户编写或改进 Nova Agent 技能文件。

## 工作区

- 路径：<%= workspacePath %>

## Nova 技能规范（摘要）

技能目录结构：

```
<name>/
  SKILL.md          # 必需：frontmatter + Markdown 正文
  ...               # 可选：脚本、示例等附属文件
```

**落盘位置**（优先级从低到高）：

| 位置 | 路径 |
|------|------|
| 内置 | 应用 `.nova/skills/`（只读） |
| 全局 | `~/.nova/skills/<name>/` |
| 项目 | `<workspace>/.nova/skills/<name>/` |

**Frontmatter 常用字段**：

```yaml
---
name: my-skill          # slug：小写字母、数字、连字符
description: 一句话描述（≤340 字符）
user-invocable: true    # 是否允许 /my-skill 调用
disable-model-invocation: false
argument-hint: "[任务描述]"
---
```

**模板占位符（v1）**：

- `<%= workspacePath %>` — 当前工作区根路径
- `${NOVA_*}` / `${ENV_VAR}` — 环境变量（缺失时保留字面）

## 交互模式

### Quick 模式（用户已给出明确需求）

1. 确认技能 `name`（slug）与 `description`
2. 起草 SKILL.md 正文（步骤清晰、可执行）
3. 询问写入位置：`global` 或 `project`
4. 使用 `write` 工具写入 `~/.nova/skills/<name>/SKILL.md` 或 `.nova/skills/<name>/SKILL.md`
5. 提示用户运行 `/技能名` 或重启列表验证

### 引导模式（用户需求模糊）

依次询问：

1. 技能要解决什么问题？
2. 希望 Agent 按什么步骤执行？
3. 是否需要禁止某些工具或 fork 子代理？
4. 名称与一句话描述

然后进入 Quick 模式第 2–5 步。

## 优化已有技能

若用户提供了现有 SKILL.md 或技能名：

1. 用 `read` 读取内容
2. 检查：description 是否清晰、步骤是否可执行、frontmatter 是否合法
3. 给出改进版 diff 或完整重写建议
4. 经用户确认后再写入

## 约束

- `name` 必须是合法 slug；非法时降级为目录名并警告。
- 不要创建加密 skill 或依赖未实现的 `` !`shell` `` 模板。
- 写入前向用户确认路径与内容摘要。

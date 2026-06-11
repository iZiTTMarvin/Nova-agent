---
name: skill-add
description: 从 URL 或 zip 安装第三方技能到 ~/.nova/skills 或项目 .nova/skills
user-invocable: true
argument-hint: "[zip 路径或 https URL]"
---

# 安装技能（skill-add）

你正在执行 **skill-add** 技能，帮助用户从 **zip 包** 或 **URL** 安装技能。

## 工作区

- 路径：<%= workspacePath %>

## 用户参数

```
${arguments}
```

若用户未提供参数，请询问：zip 本地路径、或 `https://` 下载地址，以及安装位置（`global` | `project`）。

## 安装流程

### 方式 A：本地 zip（推荐）

1. 确认 zip 路径存在（`read` 或 `bash` 检查）
2. 解压到临时目录，查找 `SKILL.md`（通常在 `<skill-name>/SKILL.md`）
3. 解析 frontmatter，校验 `name` 与 `description`
4. 目标目录：
   - **global**：`~/.nova/skills/<name>/`
   - **project**：`.nova/skills/<name>/`
5. 复制整个技能目录（含附属文件）到目标路径
6. 若同名已存在，询问是否覆盖

### 方式 B：URL 下载

1. 仅接受 `https://` 链接
2. 下载到临时目录（超时 30s）
3. 按方式 A 第 2–6 步处理

### 方式 C：设置页导入（UI）

提示用户也可在 **设置 → 技能 → 导入** 中拖拽 zip（若 UI 已启用）。

## 安装后验证

1. 列出 `SKILL.md` 的 `name` 与 `description`
2. 建议用户输入 `/技能名` 试用
3. 若解析有 warnings，逐条说明

## 安全与约束

- 不要执行 zip 内未知脚本；仅复制 Markdown 与明确附属文件。
- 不修改用户 Claude Code 源目录（`~/.claude/skills`）；第三方 Claude 技能由应用设置开关只读挂载。
- 安装失败时保留错误信息，不留下半成品目录（或清理空目录）。

## 环境提示

安装全局技能时，路径基于用户主目录下的 `.nova/skills/`。项目级技能仅对当前工作区可见。

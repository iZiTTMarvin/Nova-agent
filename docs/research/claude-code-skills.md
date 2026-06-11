# Claude Code Skills 调研笔记

> 版本：v1.0 · 2026-06-11  
> 用途：nova-agent Task 13（第三方 skill 同步）前置调研  
> 官方文档：[Extend Claude with skills](https://code.claude.com/docs/en/skills) · [.claude 目录说明](https://code.claude.com/docs/en/claude-directory)

---

## 1. 路径约定

| 级别 | 路径（Unix/macOS） | 路径（Windows） | 作用域 |
|------|-------------------|-------------------|--------|
| 个人 | `~/.claude/skills/<dir>/SKILL.md` | `%USERPROFILE%\.claude\skills\<dir>\SKILL.md` | 所有项目 |
| 项目 | `.claude/skills/<dir>/SKILL.md` | `<workspace>\.claude\skills\<dir>\SKILL.md` | 当前仓库 |
| 企业 | 托管配置（managed settings） | 同上 | 组织全员 |
| 插件 | `<plugin>/skills/<dir>/SKILL.md` | 同上 | 启用插件的项目 |
| Command（单文件） | `.claude/commands/<name>.md` | 同上 | 与 skill 同名时 skill 优先 |

**目录结构**（skill 为目录，command 为单文件）：

```
my-skill/
├── SKILL.md           # 必需，文件名大小写敏感
├── scripts/           # 可选
├── references/        # 可选
└── assets/            # 可选
```

**调用名来源**：

- Skill：目录名（非 frontmatter `name`）→ `/deploy-staging`
- Command：文件名去掉 `.md` → `/deploy`
- 插件 skill：`<plugin-name>:<dir-name>`

**优先级**（同名冲突）：enterprise > personal > project；插件使用 `plugin-name:skill-name` 命名空间避免冲突。

**热重载**：Claude Code 会 watch `~/.claude/skills/` 与项目 `.claude/skills/` 的 `SKILL.md` 变更，会话内即时生效（新建顶层目录需重启）。

---

## 2. Skill vs Command

| 类型 | 存储 | SkillAC 展示 | MVP 调度 |
|------|------|-------------|----------|
| **skill** | 目录 + `SKILL.md` | `name (skill)` | Task 2 `invokeSkill` inject/fork |
| **command** | `.claude/commands/*.md` 单文件 | `name (command)` | Task 15，MVP 仅 UI 占位 |

Custom commands 已合并进 skills 体系；`.claude/commands/deploy.md` 与 `.claude/skills/deploy/SKILL.md` 行为等价，但 skill 支持附属文件与更多 frontmatter。

---

## 3. Frontmatter 字段对比（Claude Code → Nova `SkillManifest`）

| Claude Code 字段 | Nova 字段 | 映射策略 |
|------------------|-----------|----------|
| `name` | `name` | 直接映射；非法 slug 降级为目录名 + `warnings[]` |
| `description` | `description` | 直接映射；缺失时尝试正文首段；仍无则 `invalid=true` |
| `when_to_use` | 追加到 `description` | 拼接后截断 340 字符并 warn |
| `user-invocable` | `userInvocable` | 默认 `true` |
| `disable-model-invocation` | `modelInvocable` | 取反，默认 `true` |
| `allowed-tools` | `allowedTools` | 空格/逗号分隔或 YAML 列表 → `string[]` |
| `disallowed-tools` | `forbiddenTools` | 同上 |
| `argument-hint` | `argumentHint` | 直接映射 |
| `context: fork` | `forkAgent` | `fork` → `true` |
| `fork_agent`（openclacky） | `forkAgent` | 直接映射 |
| `agent` | `agent` | 字符串或列表，限定 profile |
| `model` | `subagentModel` | fork 时子 agent 模型 |
| `hooks` | `hooks` | 解析为 `HookEvent[]`，未知项 warn |
| `name_zh` / `description_zh` | `nameZh` / `descriptionZh` | 直接映射 |
| `auto_summarize` | `autoSummarize` | 布尔，默认 false |
| `arguments` | — | v1 不实现 `$name` 替换，记入 warnings |
| `paths` | — | v1 忽略，记入 warnings |
| `shell` / `effort` | — | v1 忽略，记入 warnings |
| `` !`cmd` `` 动态注入 | — | v1 保留字面量，不执行 |

**Nova 独有字段**（Claude 无对应）：`source`、`sourcePath`、`directory`、`enabled`、`hasSupportingFiles`、`warnings`、`invalid`。

**明确不实现**：`brand`、`encrypted`、`SKILL.md.enc`（MVP 范围外）。

---

## 4. 示例 frontmatter

```yaml
---
name: code-review
description: Review code changes for bugs and style issues. Use when user asks for review.
user-invocable: true
disable-model-invocation: false
allowed-tools: Read, Grep, Bash
context: fork
agent: explore
---

# Code Review

Review the requested changes and report findings.
```

---

## 5. Cursor 用户目录（后续扩展）

- Cursor Agent Skills 常见路径：`~/.cursor/skills/`（用户级）、项目内 `.cursor/skills/` 或 skills-cursor 目录。
- **MVP 仅实现 Claude Code 路径**（`~/.claude/skills`、`.claude/skills`）；Cursor 路径写入本节后不纳入 Task 13。

---

## 6. 加载策略决策（Task 0.2）

### 6.1 选定方案：**B — 启动时同步到缓存目录**

| 方案 | 说明 | 结论 |
|------|------|------|
| A. 虚拟源只读 | 扫描时 `source: third_party_claude`，不复制 | 可行但 Claude 运行时可能锁文件 |
| **B. 同步缓存** | `~/.nova/imported/claude-skills/` 镜像 | **推荐**：只读源、避免锁、可 diff |
| C. 符号链接 | Windows 需开发者模式 | **不推荐** |

同步策略（Task 13 实施）：

1. 开关 `loadThirdPartySkills === true` 时，扫描 `%USERPROFILE%/.claude/skills` 与 `<workspace>/.claude/skills`。
2. 将 `SKILL.md` 及附属目录复制到 `~/.nova/imported/claude-skills/<scope>/<name>/`（按 mtime 增量）。
3. `SkillLoader` 从缓存目录以 `source: third_party_claude` 加载，**不修改 Claude 源目录**。

### 6.2 开关关闭时

- 不扫描、不复制、UI 不展示第三方项。
- Nova 自有 skill（builtin / global / project）行为与优先级不变。

### 6.3 优先级（低 → 高）

```
builtin(0) < third_party_claude(1) < global(2) < project(3)
```

同名覆盖时，高优先级生效；`shadowed` 记录被覆盖的低优先级来源。

> 注：实施任务清单写的是 `project > global > builtin > third_party`；与上表一致（数字越大优先级越高）。

---

## 7. 兼容性结论

| 维度 | 结论 |
|------|------|
| 文件格式 | `SKILL.md` + YAML frontmatter 与 Nova 解析器兼容度高 |
| 调用语义 | `/name args` 与 Nova `parseSlashCommand` 对齐 |
| 模板 | Claude `` !`shell` `` / `$ARGUMENTS` 在 v1 仅部分支持；`${ENV}` / `<%= key %>` 由 Nova `template.ts` 处理 |
| 子 agent | `context: fork` 映射为 `forkAgent`，对接 `taskTool` 模式 |
| 风险 | 插件命名空间 `plugin:skill` 在 MVP 不解析，第三方仅同步个人/项目 `.claude/skills` |

---

## 8. 推荐加载策略摘要

1. **Task 1–2**：Nova 原生 `.nova/skills` 三源（builtin / global / project）。
2. **Task 13**：开关默认开启，只读同步 Claude 目录到 `~/.nova/imported/claude-skills/`。
3. **Command**：MVP 不加载，SkillAC 预留 `(command)` 类型。
4. **降级**：无法映射的 frontmatter 字段进入 `warnings[]`，不阻断扫描。

---

## 9. 废弃 / 迁移对照（基线盘点 2026-06-11）

| 旧代码 | 处置 |
|--------|------|
| `SkillManifest.ts` 内联 `parseSkillMarkdown` | → `frontmatter.ts` + `types.ts` |
| `SkillRegistry.scanDir` | → `SkillLoader.ts` |
| `agentHandler.expandSlashCommand` | → `invokeSkill.ts` + `AgentLoop` |
| `invokeSkillTool` 独立 `modelClient.chat` | flag=false 保留；默认返回展开 body |
| `list-skills` 缓存仅在 send-message 更新 | Task 4 改为 SkillService.reload |

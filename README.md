# Nova Agent

极简桌面编程工作台 — 基于 Electron 的本地 AI Agent Coding Cowork，对接任意 OpenAI 兼容 API，在你的项目工作区内读代码、改文件、跑命令、管理技能与子代理。

当前版本：**0.1.0**（活跃开发中）

---

## 目录

- [特性](#特性)
- [环境要求](#环境要求)
- [快速开始](#快速开始)
- [使用说明](#使用说明)
- [技能（Skills）](#技能skills)
- [规则与子代理](#规则与子代理)
- [目录与配置路径](#目录与配置路径)
- [架构概览](#架构概览)
- [项目结构](#项目结构)
- [开发](#开发)
- [文档与变更记录](#文档与变更记录)
- [许可证](#许可证)

---

## 特性

### 对话与 Agent 运行时

- **OpenAI 兼容接口**：支持自定义 Base URL、API Key、模型 ID、上下文窗口与 Vision 开关
- **多轮工具调用**：内置 `ls` / `read` / `grep` / `find` / `edit` / `write` / `bash` / `todo_write` / `task` / `invoke_skill` 等工具
- **运行模式**：`plan`（只读规划）、`default`（写入需确认）、`auto`（自动执行，危险命令仍拦截）
- **权限审批**：高风险操作（如 `bash`）弹出确认；支持会话级 diff 审阅与文件回滚
- **检查点**：工具改文件前自动快照，支持按消息回退工作区
- **恢复管线**：模型临时错误自动重试；上下文溢出时压缩恢复；输入框上方展示恢复状态条
- **Steering Queue**：Agent 运行中可将新消息排队，当前轮次结束后自动发送
- **图片输入**：在支持 Vision 的模型下可粘贴或拖拽图片

### Skill 子系统

- **多源加载**：内置 / 全局 `~/.nova/skills` / 项目 `.nova/skills`，按优先级合并
- **Slash 命令**：输入 `/` 触发自动补全（如 `onboard (skill)`），选中后注入主对话
- **统一调度**：`/skill-name` 走 `invokeSkill` 注入或 `fork_agent` 子代理，与 `invoke_skill` 工具共用逻辑
- **设置页管理**：启用/禁用、来源标识、一键填入 Composer

### 设置与工作区

- **左右分栏设置**：LLM 配置、规则（Rules）、技能（Skills）、子代理（Subagents）
- **规则文件**：支持 `AGENTS.md`、`CLAUDE.md`、`.cursorrules` 及 `.nova/rules/*.md`
- **子代理**：内置 `explore`（只读探索）与 `code`（受限编程），可扩展自定义 JSON 配置
- **多会话**：按工作区管理会话历史，切换项目时技能列表自动 reload

### 工程化

- TypeScript 全栈类型安全；主进程与渲染进程通过类型化 IPC 通信
- Vitest 单元测试（970+ 用例）；内置 skill frontmatter 校验脚本

---

## 环境要求

| 依赖 | 版本建议 |
|------|----------|
| Node.js | 18+ |
| npm | 9+ |
| 操作系统 | Windows / macOS / Linux |

可选：系统安装 [ripgrep](https://github.com/BurntSushi/ripgrep)（`grep` 工具会优先使用内置 `@vscode/ripgrep`，亦可回退系统 `rg`）。

---

## 快速开始

```bash
# 克隆仓库
git clone <repository-url>
cd nova-agent

# 安装依赖
npm install

# 开发模式（Electron + 热更新）
npm run dev
```

首次启动后：

1. 点击左下角 **设置**，填写 LLM 接口地址、API Key 与模型 ID
2. 在侧边栏 **选择或新建项目工作区**
3. 在 Composer 中输入任务，或使用 `/onboard` 运行内置入门向导

生产构建：

```bash
npm run build
npm run preview   # 预览构建产物
```

---

## 使用说明

### 配置模型

打开 **设置 → LLM 配置**：

- **Base URL**：OpenAI 兼容 API 根地址（如 `https://api.openai.com/v1`）
- **API Key**：鉴权凭证
- **Model ID**：如 `minimax m3`、`glm-5.2` 等
- **Context Window**：可留空，按模型名自动推断
- **Vision**：自动推断 / 强制开启 / 强制关闭

配置持久化在 Electron `userData` 目录下的模型配置文件中。

### 运行模式

| 模式 | 说明 |
|------|------|
| `plan` | 只读：禁止 `edit` / `write` / `bash` |
| `default` | 写入工具可用；`bash` 需用户确认 |
| `auto` | 自动执行；仍拦截高风险 shell 命令 |

在 Composer 旁的模式切换器中切换。

### Slash 命令与 Composer

- 输入 `/` 打开技能自动补全列表
- 选择项后输入框填充为 `/skill-name `（不含 `(skill)` 后缀）
- 发送后由 `AgentLoop` 解析并注入 skill 正文，或由模型通过 `invoke_skill` 工具调用

### 权限与 Diff

- Agent 修改文件后，可在消息流中查看 diff、逐文件接受或拒绝
- 支持将对话回退到某条消息之前的状态（含工作区文件物理恢复）

---

## 技能（Skills）

### 内置技能

仓库自带 4 个核心 skill（构建时打包进应用）：

| 名称 | 说明 |
|------|------|
| `onboard` | 首次启动向导，熟悉工作区与配置 |
| `skill-creator` | 创建与优化 skill 的指引 |
| `skill-add` | 从 URL / zip 安装 skill 的指引 |
| `new` | 空白 skill 脚手架模板 |

在 Composer 中输入 `/onboard` 即可触发。

### 安装路径与优先级

优先级（高覆盖低）：**project > global > builtin**

| 来源 | 路径 |
|------|------|
| 内置 | 应用内 `.nova/skills/<name>/SKILL.md` |
| 全局 | `~/.nova/skills/<name>/SKILL.md` |
| 项目 | `<workspace>/.nova/skills/<name>/SKILL.md` |

每个 skill 为目录 + `SKILL.md`，frontmatter 至少包含 `name`、`description`；默认可通过 `/` 调用（`user-invocable: true`）。

### 自定义 Skill 示例

`~/.nova/skills/my-review/SKILL.md`：

```markdown
---
name: my-review
description: 对当前变更做代码审查
user-invocable: true
---

请审查工作区中最近的代码变更，从正确性、可读性、安全风险三方面给出建议。
```

保存后重启或切换工作区，输入 `/my-review` 即可调用。

### 校验内置 Skill

```bash
npm run validate:skills
```

---

## 规则与子代理

### 规则（Rules）

Agent 系统提示词会合并项目规则，扫描顺序：

1. 工作区根目录：`AGENTS.md` → `CLAUDE.md` → `.cursorrules`
2. 工作区：`.nova/rules/*.md`
3. 全局：`~/.nova/rules/*.md`

在 **设置 → 规则** 中可浏览、编辑与新建规则文件。

### 子代理（Subagents）

主 Agent 可通过 `task` 工具委派子任务：

| 内置名称 | 能力 |
|----------|------|
| `explore` | 只读探索（ls / read / grep / find） |
| `code` | 受限编程（含 edit / write / bash，写操作走父 Agent 权限） |

自定义配置：

- 全局：`~/.nova/subagents/<name>.json`
- 项目：`<workspace>/.nova/subagents/<name>.json`

JSON 字段对齐 `SubAgentSpec`（`name`、`description`、`allowedTools`、`prompt` 等）。在 **设置 → 子代理** 中管理。

部分 skill 支持 `fork_agent: true`，slash 调用时会直接 fork 子 Agent 执行。

---

## 目录与配置路径

| 用途 | 路径 |
|------|------|
| 全局 Nova 配置 | `~/.nova/settings.json` |
| 技能启停状态 | `~/.nova/skill-state.json` |
| 全局技能 | `~/.nova/skills/` |
| 全局规则 | `~/.nova/rules/` |
| 全局子代理 | `~/.nova/subagents/` |
| 项目技能 | `<workspace>/.nova/skills/` |
| 项目规则 | `<workspace>/.nova/rules/` |
| 项目子代理 | `<workspace>/.nova/subagents/` |
| 会话与检查点 | Electron `userData`（由应用管理） |

设置项 `loadThirdPartySkills`（默认 `true`）用于后续接入 Claude Code 技能目录，详见 `CHANGELOG.md` 与实施计划。

---

## 架构概览

```
┌─────────────────────────────────────────────────────────┐
│  Renderer (React + Zustand)                             │
│  ChatPanel · SkillAC · SettingsModal · DiffViewer     │
│       │ preload: window.api / window.nova.skill         │
└───────┼─────────────────────────────────────────────────┘
        │ IPC (类型化 channels)
┌───────▼─────────────────────────────────────────────────┐
│  Main (Electron)                                        │
│  agentHandler · skillHandler · rulesHandler · ...       │
│       │                                                 │
│  ┌────▼─────────────────────────────────────────────┐   │
│  │  Runtime                                         │   │
│  │  AgentLoop · ToolRegistry · PermissionManager    │   │
│  │  SkillRegistry / SkillService · CheckpointManager│   │
│  │  SystemPromptBuilder · RecoveryStateMachine      │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

**数据流（发送消息）**：

1. Renderer 通过 `send-message` IPC 提交用户输入
2. `invokeSkill` 预处理 slash 命令（注入 / fork / 系统提示）
3. `AgentLoop` 拼装 system prompt（含规则与 skill 上下文），调用模型
4. 模型返回 tool calls → 权限检查 → 工具执行 → 结果回注上下文
5. 流式事件（`text-delta`、`tool-call`、`diff-update` 等）推送至 UI

---

## 项目结构

```
nova-agent/
├── .nova/skills/          # 内置 skill 源码（构建时复制到产物）
├── src/
│   ├── main/              # Electron 主进程、IPC handlers
│   ├── preload/           # contextBridge API
│   ├── renderer/          # React UI
│   ├── runtime/           # Agent、工具、技能、会话、检查点
│   └── shared/            # IPC 类型、会话类型、配置类型
├── tests/unit/            # Vitest 单元测试
├── scripts/               # 校验与辅助脚本
├── electron.vite.config.ts
├── CHANGELOG.md
└── package.json
```

---

## 开发

```bash
# 类型检查
npm run typecheck

# 运行全部测试
npm test

# 监听模式
npm run test:watch

# 校验内置 skill frontmatter
npm run validate:skills
```

### 添加 IPC 通道

1. 在 `src/shared/ipc/channels.ts` 声明 channel 常量
2. 在 `src/shared/ipc/types.ts` 补充 `IpcCommands` / `IpcEvents` 类型
3. 在 `src/main/ipc/` 实现 handler，并于 `registerHandlers.ts` 注册
4. 如需暴露给渲染端，在 `src/preload/` 封装并在 `preload.d.ts` 声明

### 添加工具

在 `src/runtime/tools/` 实现 `ToolExecutor`，于 `agentHandler` 注册到 `ToolRegistry`。注意 `plan` 模式下的可见性与 `PermissionManager` 规则。

---

## 文档与变更记录

- 版本历史与近期功能：[CHANGELOG.md](./CHANGELOG.md)
- Skill 系统设计（若仓库内保留）：`docs/skill-system-design.md`

---

## 许可证

[MIT](./LICENSE) — Copyright (c) 2026 Harrison Xu

---

## 致谢

Nova Agent 在架构上参考了诸多主流高质量Agent工具，致谢：pi-agent、opencode、kilo code、openclacky

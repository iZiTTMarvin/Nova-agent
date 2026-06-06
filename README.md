# Nova Agent — Mini Coding Workbench

> 一个受 Pi 启发的极简桌面编程工作台。选择任意本地项目，用自然语言驱动 AI 完成理解、修改、验证的全流程，所有改动真实写入工作区，但始终可审查、可回退。

---

## 项目定位

Nova Agent 不是又一个追求大而全的 Coding Agent，而是一个**适合学习 Agent Loop、适合面试展示、适合日常小修小改**的桌面工作台。

它的核心体验是：

1. **项目理解** — 打开任意本地目录，让 Agent 先读目录、搜代码、做分析。
2. **代码修改** — Agent 通过 8 个内置工具精确读写文件、执行 shell、管理任务计划。
3. **可审查可回退** — 每次用户消息对应一次事务边界（Message-Scoped Checkpoint），支持按文件拒绝、按消息回退到任意历史节点。
4. **边做边验证** — 修改完成后自动探测并运行验证命令，结果即时展示在对应消息下方。

---

## 核心特性

- **三层分离架构**：Renderer UI（React）↔ Electron Host（IPC 桥接）↔ Runtime Core（纯 TypeScript）。Runtime 不依赖 Electron，可独立单测。
- **OpenAI-Compatible 流式对话**：支持 SSE 流式响应、工具调用（Tool Calling）、多轮 Agent Loop、Vision 图片上传。模型配置全局一份，持久化到磁盘。
- **8 个内置工具**：`ls` / `read` / `grep` / `find` / `edit` / `write` / `bash` / `todo_write`，全部限制在工作区内。
  - `todo_write`：把"当前计划"外化为会话级持久化状态，支持 full / compact 双视图。
- **三种工作模式**：
  - `plan` — 只读分析，不写盘，适合项目理解和方案规划。
  - `default` — 默认协作，`edit`/`write` 自动执行，`bash` 和验证需用户确认。
  - `auto` — 高自动化，危险命令（`sudo`、`rm -rf`、`curl | sh` 等）仍会被拦截。
- **工具批量执行调度**：只读工具（`ls`/`read`/`grep`/`find`）并发执行，写入和 shell 工具保持顺序；结果按完成顺序实时推送到 UI，但模型上下文仍按原始调用顺序回传。
- **相同工具调用熔断**：同一工具调用（名称 + 参数一致）连续失败 3 次自动熔断，停止本轮并向用户提示"已自动中断"，避免空转烧满 `maxToolRounds`。
- **Message-Scoped Checkpoint**：每条用户消息第一次修改文件前自动备份原始内容，回退时确定性恢复，不智能合并、不丢数据。
- **Diff 审查与回退**：消息结束后展示本轮所有文件变更的 diff，支持逐文件接受/拒绝，也支持一键回退到某条历史消息之前。
- **验证服务**：修改完成后按 `test > lint > build` 优先级自动探测并执行验证命令，结果展示在对应消息下方；default 模式下需用户确认。
- **会话持久化**：会话、消息、模式、验证摘要、Todo 列表全量持久化，重启后可继续对话。
- **多轮对话上下文恢复**：从 session 历史完整恢复模型对话上下文（user / assistant / tool / thinking），支持长会话的上下文压缩与 Token 估算。
- **思考块剥离**：自动解析模型返回的 `<think'>...</think'>` 标签，将推理过程与正文分离展示。
- **流式工具调用渲染**：模型在流式产出 `write`/`edit`/`bash` 参数时，UI 立刻出现文件卡片，等宽字体逐行刷出内容并自动滚动，完成后保留可展开状态。
- **消息 Blocks 结构化渲染**：按 thinking → text → tool → text 的顺序流式组装并渲染，避免分桶导致的顺序错乱。
- **图片上传支持**：支持拖拽或粘贴上传图片，Vision 模型可识别图片内容。
- **权限确认交互**：`bash` 命令和验证权限通过 IPC 推送到 UI，用户明确允许后才执行；取消时安全清理挂起请求，不向 session 残留"权限拒绝"工具结果。
- **取消与清理**：用户可随时取消当前执行，挂起权限请求被安全清理，不残留错误状态。

---

## 技术架构

```
┌──────────────────────────────────────────┐
│  Renderer UI (React 18 + Zustand)        │
│  聊天 / Diff / 权限 / 设置 / 模式 / Todo │
├──────────────────────────────────────────┤
│  Electron Host (main process)            │
│  窗口 / IPC / 目录选择 / 生命周期         │
├──────────────────────────────────────────┤
│  Runtime Core (纯 TypeScript)            │
│  AgentLoop / ModelClient / Tools         │
│  Permissions / Checkpoints / Verify      │
│  Sessions / ContextBuilder / Compaction  │
└──────────────────────────────────────────┘
```

**关键规则：**

- `renderer` 不直接操作文件、模型、shell，只通过 `preload` 暴露的受控 API 通信。
- `main` 不承担 Agent 业务逻辑，只做桥接和宿主能力暴露。
- `runtime` 不依赖 Electron，可脱离桌面环境独立运行单元测试。

---

## 技术栈

| 层级 | 技术 | 说明 |
|---|---|---|
| **宿主** | Electron 33+ | 桌面应用壳 |
| **构建** | electron-vite | Electron 专用 Vite 构建 |
| **语言** | TypeScript 5.x (strict) | 全项目统一 |
| **Renderer UI** | React 18 + Hooks | 函数组件 |
| **动画** | Framer Motion | 流式卡片、面板过渡 |
| **状态管理** | Zustand | 轻量，适合中型桌面应用 |
| **样式** | TailwindCSS + PostCSS | 原子化 CSS |
| **Markdown** | react-markdown + remark-gfm | 消息正文渲染 |
| **Runtime Core** | 纯 TypeScript | 不依赖 Electron API |
| **图片处理** | sharp + iconv-lite | Vision 上传与编码转换 |
| **搜索** | @vscode/ripgrep | 跨平台 grep 底层 |
| **测试** | Vitest (unit) + Playwright (e2e) | runtime 可脱离 Electron 单测 |
| **模型** | OpenAI-Compatible API | 通过 fetch 调用，支持流式 SSE 与 Vision |

---

## 快速开始

### 环境要求

- Node.js 18+
- npm 9+

### 安装依赖

```bash
npm install
```

### 开发运行

```bash
npm run dev
```

### 构建

```bash
npm run build
```

### 类型检查

```bash
npm run typecheck
```

### 运行测试

```bash
# 单元测试
npm run test

# 单元测试（监听模式）
npm run test:watch
```

---

## 使用流程

1. 启动应用，选择本地项目目录。
2. 在设置中配置 OpenAI-Compatible 模型（`baseUrl`、`apiKey`、`modelId`）。支持 Vision 的模型可识别上传的图片。
3. 选择模式：`plan`（只读分析）或 `default`/`auto`（可写入）。
4. 输入需求，例如：
   - "先理解这个项目"
   - "帮我修一个 bug"
   - "给这个项目加一个功能"
5. Agent 会读取项目、搜索代码、提出修改方案，并最终写入工作区。写入过程中 UI 会实时显示文件卡片。
6. 消息结束后，审查 Diff 面板，逐文件接受或拒绝。
7. 如需回退，点击历史消息旁的回退按钮，恢复到该消息之前的状态。
8. 使用 `todo_write` 工具或面板管理当前会话的任务计划。

---

## 项目结构

```text
nova-agent/
├── src/
│   ├── renderer/                 # React UI 层
│   │   ├── features/
│   │   │   ├── chat/             # 聊天消息列表、输入框、流式卡片、Markdown 渲染
│   │   │   ├── diff/             # Diff 审查面板、语法高亮
│   │   │   ├── mode-switch/      # plan / default / auto 模式切换
│   │   │   ├── permissions/      # 权限确认弹窗（bash / 验证）
│   │   │   ├── project-picker/   # 项目目录选择
│   │   │   ├── session-list/     # 历史会话列表
│   │   │   ├── settings/         # 模型配置 UI
│   │   │   └── todo/             # 会话级 Todo 面板
│   │   ├── components/           # 共享 UI 组件（图标、图片预览、标题栏等）
│   │   ├── stores/               # Zustand 全局状态
│   │   ├── lib/                  # 渲染层工具（图片附件、流式自滚动等）
│   │   └── styles/               # 全局样式
│   ├── main/                     # Electron 宿主层
│   │   ├── ipc/                  # IPC handler（agent / session / config / mode / project / window）
│   │   ├── app/                  # 应用生命周期
│   │   ├── services/             # 主进程服务
│   │   └── windows/              # 窗口管理
│   ├── preload/                  # 受控桥接层
│   ├── runtime/                  # 纯 TS Agent Runtime
│   │   ├── agent/                # AgentLoop、EventBus、上下文构建、压缩、批量执行
│   │   ├── model/                # ModelClient、SSE 流式解析、思考标签剥离、Token 估算
│   │   ├── tools/                # 8 个内置工具 + ToolRegistry + 截断管线
│   │   ├── permissions/          # 三模式权限决策 + 危险命令黑名单
│   │   ├── checkpoints/          # 备份、manifest、diff 状态、回退恢复
│   │   ├── sessions/             # 会话持久化（含 Todo、验证摘要）
│   │   └── verification/         # 验证策略、执行器、格式化
│   └── shared/                   # renderer / main / runtime 共用类型与工具
│       ├── config/               # 配置类型
│       ├── diff/                 # diff 计算与类型
│       ├── ipc/                  # IPC 通道与事件类型
│       ├── session/              # 会话、消息、工具可见性类型
│       └── todo/                 # Todo 数据模型
├── tests/
│   ├── unit/                     # 单元测试（按层级对应 src）
│   ├── integration/              # 集成测试
│   └── e2e/                      # 端到端测试
├── docs/
│   ├── specs/                    # 设计规格与实现计划
│   ├── design/                   # 功能设计方案
│   └── ideas/                    # 技术探索与对比报告
└── tasks/                        # 迭代任务管理
```

---

## 贡献指南

本项目目前处于快速迭代期，核心目标是验证「极简桌面 Coding Workbench」的产品假设和工程实现。

如果你希望参与：

1. 先阅读 `docs/specs/mini-coding-workbench/` 下的设计文档，理解架构决策和模块边界。
2. 遵循现有的代码风格：中文注释、Conventional Commits 中文描述、文件 ≤300 行、函数 ≤40 行。
3. 优先补充能证明问题存在或防止回归的测试。
4. 修改 Runtime Core 时，确保新代码可脱离 Electron 在 Vitest 中运行。

---

## 许可证

MIT License

---

> Nova Agent 的诞生不是为了做「最强的 Coding Agent」，而是为了做「最能讲清楚 Agent Loop 原理、最能放心演示、最能在日常小修小改中真正可用」的桌面工作台。

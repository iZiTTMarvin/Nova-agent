# Nova Agent — Mini Coding Workbench

> 一个受 Pi 启发的极简桌面编程工作台。选择任意本地项目，用自然语言驱动 AI 完成理解、修改、验证的全流程，所有改动真实写入工作区，但始终可审查、可回退。

---

## 项目定位

Nova Agent 不是又一个追求大而全的 Coding Agent，而是一个**适合学习 Agent Loop、适合面试展示、适合日常小修小改**的桌面工作台。

它的核心体验是：

1. **项目理解** — 打开任意本地目录，让 Agent 先读目录、搜代码、做分析。
2. **代码修改** — Agent 通过 7 个内置工具精确读写文件，执行 shell 命令。
3. **可审查可回退** — 每次用户消息对应一次事务边界（Message-Scoped Checkpoint），支持按文件拒绝、按消息回退到任意历史节点。

---

## 核心特性

### 已交付（v0.1.x）

- **三层分离架构**：Renderer UI（React）↔ Electron Host（IPC 桥接）↔ Runtime Core（纯 TypeScript）。Runtime 不依赖 Electron，可独立单测。
- **OpenAI-Compatible 流式对话**：支持 SSE 流式响应、工具调用（Tool Calling）、多轮 Agent Loop，模型配置仅全局一份。
- **7 个内置工具**：`ls` / `read` / `grep` / `find` / `edit` / `write` / `bash`，全部限制在工作区内。
- **三种工作模式**：
  - `plan` — 只读分析，不写盘，适合项目理解和方案规划。
  - `default` — 默认协作，`edit`/`write` 自动执行，`bash` 需用户确认。
  - `auto` — 高自动化，危险命令（`sudo`、`rm -rf`、`curl | sh` 等）仍会被拦截。
- **Message-Scoped Checkpoint**：每条用户消息第一次修改文件前自动备份原始内容，回退时确定性恢复，不智能合并、不丢数据。
- **Diff 审查与回退**：消息结束后展示本轮所有文件变更的 diff，支持逐文件接受/拒绝，也支持一键回退到某条历史消息之前。
- **验证服务**：修改完成后按 `test > lint > build` 优先级自动探测并执行验证命令，结果展示在对应消息下方。
- **会话持久化**：会话、消息、模式、验证摘要全量持久化，重启后可继续对话。
- **思考块剥离**：自动解析模型返回的 `<think'>...</think'>` 标签，将推理过程与正文分离展示。
- **权限确认交互**：`bash` 命令和验证权限通过 IPC 推送到 UI，用户明确允许后才执行。
- **取消与清理**：用户可随时取消当前执行，挂起权限请求被安全清理，不残留错误状态。

### 正在进行（即将交付）

- **流式工具调用渲染（Streaming Tool Call）**：模型在流式产出 `write`/`edit` 参数时，UI 立刻出现写入文件卡片，等宽字体逐行刷出代码，实时行号与自动滚动，完成后自动收起为绿色对勾状态。

---

## 技术架构

```
┌─────────────────────────────────────┐
│  Renderer UI (React 18 + Zustand)   │
│  聊天 / Diff / 权限 / 设置 / 模式    │
├─────────────────────────────────────┤
│  Electron Host (main process)       │
│  窗口 / IPC / 目录选择 / 生命周期    │
├─────────────────────────────────────┤
│  Runtime Core (纯 TypeScript)       │
│  AgentLoop / ModelClient / Tools    │
│  Permissions / Checkpoints / Verify │
└─────────────────────────────────────┘
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
| **状态管理** | Zustand | 轻量，适合中型桌面应用 |
| **Runtime Core** | 纯 TypeScript | 不依赖 Electron API |
| **测试** | Vitest (unit) + Playwright (e2e) | runtime 可脱离 Electron 单测 |
| **模型** | OpenAI-Compatible API | 通过 fetch 调用，支持流式 SSE |

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
2. 在设置中配置 OpenAI-Compatible 模型（`baseUrl`、`apiKey`、`modelId`）。
3. 选择模式：`plan`（只读分析）或 `default`/`auto`（可写入）。
4. 输入需求，例如：
   - "先理解这个项目"
   - "帮我修一个 bug"
   - "给这个项目加一个功能"
5. Agent 会读取项目、搜索代码、提出修改方案，并最终写入工作区。
6. 消息结束后，审查 Diff 面板，逐文件接受或拒绝。
7. 如需回退，点击历史消息旁的回退按钮，恢复到该消息之前的状态。

---

## 项目结构

```text
nova-agent/
├── src/
│   ├── renderer/           # React UI 层
│   │   ├── features/
│   │   │   ├── chat/       # 聊天消息列表、输入框、流式卡片
│   │   │   ├── diff/       # Diff 审查面板
│   │   │   ├── mode-switch/# plan/default/auto 切换
│   │   │   ├── permissions/# 权限确认弹窗
│   │   │   ├── project-picker/
│   │   │   ├── session-list/
│   │   │   └── settings/   # 模型配置
│   │   ├── stores/         # Zustand 状态管理
│   │   └── components/       # 共享 UI 组件
│   ├── main/               # Electron 宿主层
│   │   └── ipc/            # IPC handler
│   ├── preload/            # 受控桥接层
│   ├── runtime/            # 纯 TS Agent Runtime
│   │   ├── agent/          # AgentLoop、EventBus、上下文构建
│   │   ├── model/          # ModelClient、SSE 流式解析、思考标签剥离
│   │   ├── tools/          # 7 个内置工具
│   │   ├── permissions/    # 三模式权限决策
│   │   ├── checkpoints/    # 备份、manifest、回退恢复
│   │   ├── sessions/       # 会话持久化
│   │   └── verification/   # 验证策略与执行
│   └── shared/             # renderer / main / runtime 共用类型
├── tests/
│   ├── unit/               # 单元测试
│   ├── integration/        # 集成测试
│   └── e2e/                # 端到端测试
├── docs/specs/             # 设计规格与实现计划
│   ├── mini-coding-workbench/
│   │   ├── design.md       # 架构设计
│   │   ├── structure.md    # 目录结构规范
│   │   └── tasks.md        # 原始任务列表
│   └── STREAMING_TOOL_CALL_PLAN.md  # 流式工具调用渲染计划
└── tasks/
    └── todo.md             # 当前迭代 Todo
```

---

## 未来路线图

### 近期（当前迭代）

- [x] Phase S1 — 数据通路：SSE 工具调用增量事件从模型层到 Renderer 的全链路打通
- [x] Phase S2 — 渲染层流式状态 + partial JSON 解析 + 事件订阅
- [ ] **Phase S3 — 流式写入卡片 UI（StreamingFileCard）**：`write`/`edit` 工具在模型流式产出参数期间，UI 立刻出现参考 DiffViewer 风格的写入文件卡片，body 用等宽字体逐行刷出代码并自动滚动到底部，完成后自动收起。
- [ ] **Phase S4 — 端到端验证**：长 HTML 写入、edit 修改、手动展开/收起保护、取消执行、plan mode 隐藏、性能与回归校验。


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

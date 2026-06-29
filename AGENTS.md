# AGENTS.md

本文件面向后续 AI Agent开发前理解项目，补充仓库 README 不易直接看出的工程惯例与命令细节。若与 README 冲突，先去开真实代码，就怕readme和本文件更新不及时。如果是开发准则，请优先阅读此文档。

---

## 1. 项目本质

- Electron 33 + React 18 + TypeScript 5 的桌面 AI Coding Workbench。
- 核心循环（AgentLoop / Tools / ModelClient / Permissions / Checkpoints）放在 `src/runtime/`，刻意不依赖 Electron API，以便单测。
- 渲染层只通过类型化 IPC 与主进程通信，不直接操作文件或模型。

---

## 2. 常用开发与验证命令

```bash
# 安装依赖
npm install

# 开发启动（Electron + Vite 热更新）
npm run dev

# 类型检查（全项目严格模式）
npm run typecheck

# 运行全部单元测试（Vitest，当前约 1500 用例）
npm test

# 监听测试
npm run test:watch

# 生产构建
npm run build

# 构建后预览
npm run preview

# 校验内置 skill frontmatter
npm run validate:skills
```

CI/提交前建议顺序：`typecheck -> test -> build`，因为 `build` 还会触发自定义 Vite 插件复制静态资源。

---

## 3. 构建与路径约定

- 入口：`package.json` 的 `main` 指向 `./out/main/index.js`，由 `electron-vite` 构建生成。
- TypeScript path alias：
  - `@renderer/*` -> `src/renderer/*`
  - `@main/*` -> `src/main/*`
  - `@preload/*` -> `src/preload/*`
  - `@runtime/*` -> `src/runtime/*`
  - `@shared/*` -> `src/shared/*`
- 构建时会自动复制两类静态资源到 `out/main`：
  1. `.nova/skills/*` -> `out/main/.nova/skills`（内置技能）
  2. `src/runtime/agent/prompts/*` -> `out/main/prompts`（agent prompt 模板）

如果运行时提示找不到 `.nova/skills` 或 `prompts/base-rules.md`，先跑一次 `npm run build`。

---

## 4. 技能（Skills）

- 内置技能目录：`.nova/skills/<name>/SKILL.md`，构建时打包进产物。
- 全局技能：`~/.nova/skills/<name>/SKILL.md`。
- 项目技能：`<workspace>/.nova/skills/<name>/SKILL.md`。
- 优先级：**project > global > builtin**。
- 每个 `SKILL.md` 必须含 YAML frontmatter，至少 `name`、`description`。
- 可用命令行安装 skill（需要先 build）：
  ```bash
  node scripts/install-skill.mjs <zip或https-url> [--project <工作区路径>]
  ```
- 打包单个 skill：
  ```bash
  node scripts/package-skill.mjs <skill目录> [输出.zip]
  ```

---

## 5. IPC 与功能扩展流程

若需新增 renderer ↔ main 通信：

1. `src/shared/ipc/channels.ts` 添加 channel 常量。
2. `src/shared/ipc/types.ts` 补充 `IpcCommands` / `IpcEvents` 类型。
3. `src/main/ipc/` 下实现 handler，并在 `registerHandlers.ts` 注册。
4. 如需暴露给渲染进程，在 `src/preload/` 封装并在 `preload.d.ts` 声明。

若需新增工具：

1. 在 `src/runtime/tools/` 实现 `ToolExecutor`。
2. 在 `src/main/ipc/agentHandler.ts` 注册到 `ToolRegistry`。
3. 注意 `plan` 模式下写入类工具的可见性与 `PermissionManager` 规则。

---

## 6. 运行模式与权限

| 模式 | 含义 |
|------|------|
| `plan` | 只读：`edit` / `write` / `bash` 被拒绝 |
| `default` | 写入可用；`bash` 需要用户确认 |
| `auto` | 自动执行；仍拦截高风险 shell 命令 |

高风险操作（bash、写入类工具）会弹出权限确认；修改后可在消息流中逐文件接受或拒绝，也支持按消息回退。

---

## 7. 测试与单测约定

- 单测使用 Vitest，放在 `tests/unit/`。
- 测试运行不需要启动 Electron，runtime 与 renderer 逻辑均可独立测试。
- 部分测试依赖文件系统真实操作或子进程（如 `bashTool.test.ts`），运行时间可能较长（单条数百毫秒到数秒）。
- 当前约 1498 个用例、149 个测试文件，全量运行约 30~90 秒。

运行单个测试文件示例：

```bash
npx vitest run tests/unit/runtime/tools/bashTool.test.ts
npx vitest run tests/unit/renderer/MessageItem.test.ts
```

---

## 8. 代码风格与提交（重点）

- TypeScript 严格模式开启，不接收隐式 `any`。
- 代码注释优先中文，除非仓库已有明确的英文注释规范。
- Git commit message 使用中文，遵循这样子的格式，举个例子：
```
  fix(renderer): 根治流式/bash 权限期间消息区卡顿

修复：
  bash 权限弹窗或工具卡出现时 UI 数秒无响应（Idle 飙高、主线程硬卡）

  等待 askQuestion/权限期间误触发整条消息 Markdown 逐行高亮尖峰
  
改动： 
StreamingTextBlock：区分 paused 与轮次结束，暂停期停打字机、不做终态高亮

MessageItem：拆分 isPausedForInput / isTurnActiveForThisMsg；接入 static/live 分层

  ```
- 不要读取 `.env` 或私钥文件，也不要在代码中硬编码密钥。
- 注释里禁止写 `PRD §6.4`、`§8 Phase 3`、`pi-agent §4.3` 这类外部文档章节引用。没有上下文的人看不懂，应改为描述当前代码里的**具体行为、职责或边界条件**。重点！！！！
- 新增 tools 必须放在 `src/runtime/tools/<toolName>/` 子文件夹内，并通过子文件夹的 `index.ts` 统一对外导出（参考 `src/runtime/tools/webSearch/`）。禁止在 `src/runtime/tools/` 根目录直接新增单个平铺文件。 重点！！！！

                           
---

## 9. 值得关注的路由与模块

- `src/main/index.ts`：Electron 主进程入口，启动时加载持久化模型配置。
- `src/main/ipc/agentHandler.ts`：连接 UI 与 `AgentLoop`，管理 checkpoint、权限、skill、askQuestion 等。
- `src/runtime/agent/AgentLoop.ts`：核心循环门面，装配模型、工具、权限、上下文压缩。
- `src/runtime/tools/index.ts`：工具统一出口。
- `src/runtime/model/dialect.ts`：模型工具调用方言判定（native / XML），当前默认 native 优先。
- `src/runtime/checkpoints/CheckpointManager.ts`：文件快照与消息级回退。

---

## 10. 常见问题

- **运行时找不到 skill 或 prompt**：先执行 `npm run build`。
- **安装 skill 脚本报错找不到 `out/main/runtime/skills/SkillService.js`**：同样先 `npm run build`。
- **权限类回归问题**：优先检查 `src/shared/session/toolVisibility.ts` 与 `src/runtime/permissions/rules.ts`，未归类工具会被默认按 bash 处理。

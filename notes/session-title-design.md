# 会话标题设计纪要

**状态**：方案已对齐并完成代码现状核实，可实施。

> 本文件 §4 以下的技术实现要点已对照仓库真实代码逐条核实（核实时间 2026-07-02）。会话的事实源、IPC 链路、注入点、刷新机制均与早期草稿不同，落地时以本文件为准。

---

## 1. 问题背景

当前会话列表项仅显示：

- 项目名（`workspaceRoot` 最后一级）
- 更新时间
- 消息条数（`messageCount`）

没有会话标题，导致多个会话同属一个项目时难以区分主题。

---

## 2. 竞品调研结论

| 产品 | 标题生成 | 手动改名 | 备注 |
|------|---------|---------|------|
| **Cursor** | 根据第一条消息自动生成 | 侧边栏右键 Rename | 用户希望支持 `/rename` 和 hook 自动改名 |
| **Claude Code** | 第一条消息后 AI 生成标题 | hover 会话项出现 rename / remove | 官方文档明确说明，支持 `/rename` |
| **Windsurf / Cascade** | 未明确披露机制；类似 Windmill 实现为第一次完整轮次后调用 LLM 生成 2–6 词标题 | 支持 | 手动重命名后标记 `summarySource=manual`，防止被自动覆盖 |
| **ChatGPT / Codex** | 根据第一条消息自动摘要 | 支持 | Codex 用户有诉求增加"取首句前几个字"策略 |

**主流共识**：

1. 触发点一般在**第一次完整轮次后**（用户发首条 + 模型回复保存）。
2. 手动重命名后不应被子更新覆盖。
3. 新会话创建后通常先显示占位名（如"New session"），待首条消息发送后再替换为真实标题。

---

## 3. 已对齐的方案

采用 **方案 B + 方案 C**：

- **自动生成**：取**第一条用户消息**的纯文本前 **30 个中文字符**，超过部分截断加省略号。若首条消息只有图片（提取出的纯文本为空），则回退显示项目名，直到出现文字消息再更新。
- **手动编辑**：会话列表项 hover 时显示编辑按钮，点击后行内编辑标题。编辑后保存为 `manual` 来源。
- **覆盖保护**：一旦用户手动编辑过，后续自动截取不再覆盖该标题。
- **空会话**：新会话创建后尚未发送消息时，显示占位名（如"新会话"），发送第一条文字消息后替换为自动标题。

### 3.1 标题来源状态机

```text
placeholder  →  generated  →  manual
（占位名）    →  （自动截取） →  （用户手动改名）
```

- `placeholder`：可被 `generated` 覆盖。
- `generated`：可被 `manual` 覆盖；手动改名后固定为 `manual`。
- `manual`：不再被任何自动逻辑覆盖。

### 3.2 字符数限制

- 列表展示最大 30 字，截断加 `…`。
- 编辑框输入也限制 30 字。

---

## 4. 技术实现要点

> 落地前必读：会话的**单一事实源是 `WorkspaceService`（`workspace:*` IPC），不是 `sessionHandler.ts`**。renderer 侧边栏的会话列表来自 `workspace:get` / `workspace:changed` 广播里的 `availableSessions`，而 `sessionHandler.ts` 中的 `LOAD_SESSIONS` 在 renderer 已无调用方。因此标题的写入、改名、列表刷新都要走 `WorkspaceService` + `workspace:*` 链路。

### 4.1 数据模型

标题字段需加在**三处**（草稿曾遗漏 `SessionSummary`）：

| 文件 | 类型 | 新增字段 |
|------|------|---------|
| `src/runtime/sessions/types.ts` | `SessionSummary` | `title?: string`、`titleSource?: 'placeholder' \| 'generated' \| 'manual'` |
| `src/runtime/sessions/types.ts` | `SessionData` | `title?: string`、`titleSource?: 'placeholder' \| 'generated' \| 'manual'` |
| `src/shared/session/types.ts` | `Session` | `title?: string` |

`SessionSummary`（持久化层摘要）经 `WorkspaceService.toSession` 转换成 renderer 侧的 `Session`；两边字段都要透传 `title`，否则侧边栏拿不到。`titleSource` 只在持久化层流转，不暴露给 `Session`（renderer 不需要它）。

### 4.2 自动生成

**注入点**：`src/main/ipc/agentHandler.ts` 的 send-message handler 中，`sessionStore.appendMessage(params.sessionId, userMessage)`（约 L461，非 regenerate 分支）**之后**。不要把逻辑塞进 `SessionStore.appendMessage` 本身——那是个纯持久化层模块（刻意不依赖 Electron、可单测），往里加"判断首条 + 广播副作用"会破坏职责边界。

**判断"首条用户消息"的条件**（关键，别踩坑）：

```ts
const hasUserMsg = session.messages.some(m => m.role === 'user')
```

- 不要用 `currentLeafId === null`：编辑重发首条用户消息时，`WorkspaceService` 会把叶子倒回 null（见 `WorkspaceService` 的 edit-resend 实现），会产生误判。
- 不要用 `messages.length === 0`：会话历史可能含纯 assistant / 分叉残留。

**生成流程**：

1. append 之前先用上面的条件判断 `!hasUserMsg`，命中即为首条。
2. 用现成的 `extractTextFromSerializableContent(persistContent)`（已从 `runtime/sessions/types` 导入）提取纯文本。`persistContent` 在构造 `userMessage` 时已就绪。
3. 取首尾空白清理后的前 30 字；超过则截断加 `…`；若提取结果为空（纯图片消息），不生成 `generated` 标题，保留当前 `placeholder`，等后续出现文字消息再更新（因此判断条件里不能只看"首条"，而要看"当前会话是否还没有任何含文字的 user 消息"——见下方注意点）。
4. 调用新增的 `sessionStore.updateTitle(sessionId, title, 'generated')`（见 4.5）；该方法内部仅在 `titleSource !== 'manual'` 时才写入。
5. **必须触发 `WorkspaceService` 广播**：写完标题后调用 `getWorkspaceService()`（`sessionHandler.ts` 已有该 import 先例）让它重新 `list()` 并 `broadcast()`，否则 renderer 侧 `sessions` 列表不会刷新——列表数据只来自 `workspace:changed`，不来自 `load-sessions`。

> 注意点（纯图片回退的判定）：自动生成不应只绑死"第一条"，而应绑"第一条**含文字**的用户消息"。若用户首条只发图片，`titleSource` 仍是 `placeholder`；之后发一条带文字的消息时应触发 `generated`。实现上可把 4.2 的判断条件收紧为 `!session.messages.some(m => m.role === 'user' && extractTextFromSerializableContent(m.content).trim() !== '')`。

### 4.3 手动编辑

新增 IPC channel `workspace:rename-session`，**完全镜像已有的 `workspace:delete-session` 链路**（不要叫 `session:rename`，事实源不在 `sessionHandler.ts`）。`workspace:delete-session` 的完整注册链路作为模板：

| 步骤 | delete-session 现状（参照） | rename-session 需新增 |
|------|---------------------------|----------------------|
| channel 定义 | `src/shared/ipc/channels.ts` `WORKSPACE_DELETE_SESSION` | `WORKSPACE_RENAME_SESSION = 'workspace:rename-session'` |
| 类型签名 | `src/shared/ipc/types.ts` 的 `IpcCommands` | `'workspace:rename-session': { params: { sessionId: string; title: string }; result: WorkspaceState }` |
| handler 注册 | `src/main/ipc/workspaceHandler.ts`（委托 service，无业务逻辑） | 同位置加 `ipcMain.handle(WORKSPACE_RENAME_SESSION, (_e, p) => service.renameSession(p))` |
| service 实现 | `WorkspaceService.deleteSession`（写状态 + `broadcast()`） | 新增 `renameSession`：`store.updateTitle(sessionId, title, 'manual')` → 刷新 `availableSessions: store.list()` → `this.broadcast()` → `return this.getState()` |
| renderer action | `src/renderer/stores/useWorkspaceStore.ts` 的 `deleteSession`（invoke + `dispatchWorkspaceChange`） | 新增 `renameSession`，模式相同 |
| 调用方 | `SessionList.tsx` 经 `useAppStore.deleteSession` | `SessionList.tsx` 编辑按钮提交时调用 |

要点：

1. **无需改 `registerHandlers.ts`**：workspace 的 handler 在 `registerWorkspaceHandler` 内部 `ipcMain.handle`，已被注册覆盖。
2. **无需改 preload**：preload 用的是通用类型安全 `invoke` 封装，新 channel 加进 `IpcCommands` 后自动可用，类型声明也是泛型自动覆盖。
3. **刷新机制**：service 写完后 `broadcast()`（发 `workspace:changed`），renderer 的 `dispatchWorkspaceChange → syncFromWorkspace` 自动更新列表。不要用 `messagesRevision`（那是同会话内重拉消息历史用的，不刷新列表）。

### 4.4 列表展示与编辑 UI（renderer）

布局改动量很小：`.session-item__info` 已是纵向 flex（`display:flex; flex-direction:column; gap:4px`），当前两行是 `__project`（项目名）+ `__meta`（时间/条数）。

- 在 `__project` 与 `__meta` 之间插一行 `.session-item__title`，复用 `__project` 已有的 `text-overflow:ellipsis; white-space:nowrap; overflow:hidden` 三件套。展示文案：`session.title` 为空时回退到项目名。
- 编辑按钮 `.session-item__rename-btn`：完全复用现有 `.session-item__delete-btn` 的 hover 显隐模式（默认 `opacity:0`，`.session-item:hover` 时 `opacity:1`）。可以把 rename / delete 包进一个 `__actions` 容器统一显隐。
- 编辑交互建议用 inline `<input>`（聚焦时自动选中文本，回车提交、Esc 取消、失焦提交）；也可复用 `window.api.invoke('dialog:confirm', …)` 走弹窗，但 inline 体验更好。
- 输入限制 30 字；图标用 `src/renderer/components/Icons.tsx`，无现成 Pencil/Edit 图标就加一个。

涉及文件：

- `src/renderer/features/session-list/SessionList.tsx`：标题行 + 编辑按钮 + inline 编辑状态。
- `src/renderer/features/session-list/SessionList.css`：标题行样式 + 编辑按钮样式（各约十几行）。
- `src/renderer/stores/useWorkspaceStore.ts`：`renameSession` action。
- `src/renderer/stores/useChatStore.ts` / `useAppStore.ts`：如需保持 `useAppStore.xxx` 调用习惯，加透传 action（可选，也可让 SessionList 直接调 `useWorkspaceStore.getState().renameSession`）。

### 4.5 持久化层（SessionStore）

新增 `updateTitle(sessionId, title, source)`，**镜像现有的 `updateMode`**（`src/runtime/sessions/SessionStore.ts`，只写 `session.json` 元数据、不碰 `messages.jsonl`）：

- 覆盖保护写在这里：仅当当前 `titleSource !== 'manual'` 时才写入 `title` 与 `titleSource`。手动改名也走这个方法（传入 `'manual'`）。
- 写完调 `saveMetadata` 即可。

同时 `create()` 创建新会话时写入初始占位标题：`title: '新会话'`（或可配置文案）、`titleSource: 'placeholder'`，与 4.1 状态机的初始态对齐。

`SessionStore.list()` 与 `toMetadata` 需把 `title` / `titleSource` 一起带出（`toMetadata` 已是解构 `messages` 后透传其余字段，新增字段会自动带上，确认即可）。

### 4.6 旧会话迁移（migrations）

当前 `CURRENT_SESSION_SCHEMA_VERSION = 4`。`title` 虽是可选字段，但项目惯例是"结构变化即升版本、一次性迁移统一结构"（见 `migrations.ts` 文件头设计意图），运行时不靠 `typeof` 兜底。**建议升 v4→v5**：

1. `migrations.ts` 顶部 `CURRENT_SESSION_SCHEMA_VERSION = 5`。
2. 新增 `migrateV4ToV5(data)`，风格参考现有 `migrateV3ToV4`（纯函数 `(data: unknown) => SessionData`，返回 `{ ...session, schemaVersion: 5, <新字段> }`）。
3. 把 `migrateV4ToV5` 追加到 `MIGRATIONS` 数组末尾（索引 = 起始版本）。
4. 迁移逻辑：对旧会话，若已含 user 消息则按 4.2 规则生成 `generated` 标题；否则给 `placeholder`（如 `title: '历史会话'`、`titleSource: 'placeholder'`）。这样老会话首启即有标题，UI 不必写 `title ?? fallback`。

`migrateSessionFile` 已有"迁移前备份 + 失败保留原文件"逻辑，升版本后老会话首次 load/list/append 时自动迁移并备份，无需额外处理。

### 4.7 修改范围总览

| 文件 | 改动 |
|------|------|
| `src/runtime/sessions/types.ts` | `SessionData` / `SessionSummary` 加 `title?` + `titleSource?` |
| `src/shared/session/types.ts` | `Session` 加 `title?` |
| `src/runtime/sessions/migrations.ts` | 升 v5 + `migrateV4ToV5` |
| `src/runtime/sessions/SessionStore.ts` | `create` 写占位标题；新增 `updateTitle`（含覆盖保护）；`list`/`toMetadata` 透传字段 |
| `src/main/ipc/agentHandler.ts` | send-message handler 首条 user 消息后生成标题 + 触发广播 |
| `src/main/services/WorkspaceService.ts` | `toSession` 透传 `title`；新增 `renameSession`（store + list + broadcast） |
| `src/shared/ipc/channels.ts` | `WORKSPACE_RENAME_SESSION` |
| `src/shared/ipc/types.ts` | rename 类型签名 |
| `src/main/ipc/workspaceHandler.ts` | rename handler（委托 service） |
| `src/renderer/stores/useWorkspaceStore.ts` | `renameSession` action |
| `src/renderer/stores/useChatStore.ts` / `useAppStore.ts` | 透传 action（可选） |
| `src/renderer/features/session-list/SessionList.tsx` + `.css` | 标题行 + hover 编辑按钮 + inline 编辑 |

---

## 5. 未决事项

- 是否允许用户通过 `/rename` 命令或快捷键改名？（当前仅讨论侧边栏 UI 入口）
- 标题是否需要显示在窗口标题栏或顶部导航？（当前仅讨论侧边栏列表）
- 是否需要在会话详情页也允许编辑标题？

---

## 6. 决策记录

- 2026-07-01：讨论确认采用"首条用户消息前 30 字 + 手动编辑 + 手动后锁定"方案；空会话显示占位名。
- 2026-07-02：对照仓库真实代码核实技术实现要点。关键修正：
  - 会话事实源是 `WorkspaceService` + `workspace:*` IPC，而非 `sessionHandler.ts`；手动改名走 `workspace:rename-session`（镜像 `workspace:delete-session`）。
  - 列表刷新依赖 `workspace:changed` 广播，不是 `messagesRevision`；自动生成标题后必须主动广播一次。
  - 自动生成注入点放在 `agentHandler.ts` 的 send-message handler（append 之后），不放进纯持久化层 `SessionStore.appendMessage`。
  - 判断首条用户消息用 `session.messages.some(m => m.role === 'user')`，避免 `currentLeafId === null` / `messages.length === 0` 的误判。
  - 字段需加在 `SessionData` / `SessionSummary` / `Session` 三处。
  - 迁移升 v4→v5，旧会话回填标题，运行时不做兜底。

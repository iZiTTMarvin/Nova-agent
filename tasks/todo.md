# Review 修复 Todo 清单

> 基于 `tasks/review-fixes.md` 拆解
> 生成日期：2025-05-25

---

## Phase 1：P0 核心体验修复

### T1 [P0] 修复 DiffViewer `+0 -0` 突变体验断裂

**目标**：工具执行完成后，DiffViewer 不再出现 `+0 -0` 中间态，改为 loading skeleton 或直接显示真实数据。

**采用方案**：方案 A — 实时事件保持轻量信号 + 前端进入 loading skeleton

- [x] **T1-1** 修改 `emitLiveDiffUpdate` 事件格式
  - 文件：`src/main/ipc/agentHandler.ts:287-308`
  - 在发送的事件对象中增加 `phase: "live"` 字段，标识这是占位信号
  - 检查该事件是否只包含 `{ filePath, status }`，确认不含 hunks
  - 验收：emitLiveDiffUpdate 发出的事件包含 `phase: "live"`

- [x] **T1-2** 修改 `handleDiffUpdate` 处理逻辑
  - 文件：`src/renderer/stores/useAppStore.ts:629-649`
  - 收到 `phase: "live"` 事件时，不写入 `messageDiffs[id]`
  - 改为将 messageId 加入 `loadingDiffs` Set，并附带文件路径列表
  - 或者写入带 `isStub: true` 标记的占位数据：`{ diffs: [], reviews: {}, isStub: true }`
  - 验收：live 阶段不会向 messageDiffs 写入空 hunks 数据

- [x] **T1-3** DiffViewer 增加 loading skeleton 渲染分支
  - 文件：`src/renderer/features/diff/DiffViewer.tsx:319-328`
  - 当数据含 `isStub: true` 或处于 loading 状态时，显示文件名列表 + spinner
  - 不渲染 `+X -Y` 统计数字
  - 验收：loading 阶段不显示 `+0 -0`

- [x] **T1-4** 修改 ChatPanel 的 DiffViewer 渲染条件
  - 文件：`src/renderer/features/chat/ChatPanel.tsx:436-452`
  - 调整 loading 态判定：`loadingDiffs.has(id)` 即显示 loading skeleton
  - 确保 `isStub` 数据不触发真实 diff 渲染
  - 验收：loading skeleton 正确显示，message_end 后替换为真实数据

- [x] **T1-5** 消除重复 LCS 计算
  - 文件：`src/main/ipc/agentHandler.ts:287-308`、`src/main/ipc/sessionHandler.ts:123-138`
  - emitLiveDiffUpdate 改为只读 manifest 文件列表，不调用 `buildMessageDiffState` 算 LCS
  - 确认 message_end 路径的 `get-message-diffs` 才是唯一调用 `buildMessageDiffState` 的地方
  - 验收：同一份 LCS 计算只执行一次

- [x] **T1-6** 编写 T1 回归测试
  - 模拟事件序列：`tool_result` → `diff_update(phase: "live")` → `message_end`
  - 断言前端从未在某个时刻渲染过 `+0 -0`
  - 验收：测试通过

---

## Phase 2：P1 稳定性修复

### T2 [P1] EventBus 同步回调内 IO + LCS 异步化

**目标**：大文件写入时，tool_result 到下一个 thinking_delta 间隔不超过 50ms。

> 如果 T1 方案 A 落地（emitLiveDiffUpdate 不再算 LCS），本任务的核心问题已自动解决大半。但仍需确保同步 IO 路径不阻塞事件循环。

- [x] **T2-1** 确认 T1 方案 A 落地后 emitLiveDiffUpdate 的 IO 行为
  - 文件：`src/main/ipc/agentHandler.ts:154-163`
  - 检查 emitLiveDiffUpdate 改造后是否还有同步 readFileSync 调用
  - 如果只剩文件列表读取，确认列表读取是否可异步化
  - 验收：确认无同步阻塞 IO

- [x] **T2-2** 将 emitLiveDiffUpdate 调度改为异步
  - 文件：`src/main/ipc/agentHandler.ts`
  - 用 `setImmediate` / `queueMicrotask` 包裹 emitLiveDiffUpdate 调用
  - 确保当前 EventBus emit 调用栈不被阻塞
  - 验收：EventBus 单次 emit 调用栈内不含 LCS / 大文件 IO

- [x] **T2-3** 添加性能埋点
  - 在 EventBus emit tool_result 前后记录时间戳
  - 在 emitLiveDiffUpdate 调用前后记录时间戳
  - 输出日志格式：`[perf] tool_result → diff_update: {duration}ms`
  - 验收：可通过日志确认间隔 < 50ms

- [x] **T2-4** 手动验证大文件场景
  - 用 1MB 文本文件的写入场景测试
  - 观察 tool_result 与下一个 thinking_delta 之间间隔
  - 验收：间隔不超过 50ms

---

### T3 [P1] cancel 时不再向 session 残留"权限拒绝"工具结果

**目标**：用户取消后，session 文件中不出现"权限拒绝"的工具结果条目。

- [x] **T3-1** 修改 cancel() 的权限请求处理
  - 文件：`src/runtime/agent/AgentLoop.ts:320-332`
  - cancel() 时不再 `resolve(false)`，改为抛出 AbortError
  - checkPermission 捕获 AbortError 后返回特殊状态 `aborted`
  - 验收：cancel 路径不产生"权限拒绝"字符串

- [x] **T3-2** AgentLoop 处理 aborted 状态
  - 文件：`src/runtime/agent/AgentLoop.ts`
  - 检测到 checkPermission 返回 `aborted` 时，不 emit tool_result
  - 不将该工具调用 push 到 context
  - 验收：aborted 工具调用不会产生 tool_result 事件

- [x] **T3-3** 持久化层添加 cancelled 状态检查（双重保险）
  - 文件：`src/main/ipc/agentHandler.ts:267-275`
  - accumulateStreamEvent 在 message_end 分支检查 agentLoop 是否 cancelled
  - 如果 cancelled，保存前剔除"权限拒绝"类型的 tool block
  - 验收：即使 runtime 层有遗漏，持久化层也能兜底过滤

- [x] **T3-4** 编写 T3 集成测试
  - 模拟：permission_request 期间调用 cancel()
  - 断言 sessionStore 中保存的消息 toolCalls 不含权限拒绝结果
  - 断言正常完成的工具调用仍然被保留
  - 验收：测试通过

---

## Phase 3：P2 渲染优化

### T4 [P2] scrollToBottom 高频 smooth 动画排队抖动

**目标**：思考阶段滚动不再抖动，用户手动上滚后不再被自动拉回底部。

- [x] **T4-1** 修改滚动依赖项
  - 文件：`src/renderer/features/chat/ChatPanel.tsx:244-246`
  - useEffect 依赖从 `[messages, isGenerating]` 改为 `[messages.length, isGenerating]`
  - 验收：流式 delta 不再触发完整滚动

- [x] **T4-2** 添加流式阶段专用滚动器
  - 文件：`src/renderer/features/chat/ChatPanel.tsx`
  - 用 `requestAnimationFrame` 节流（约 16ms 间隔）
  - 流式阶段滚动行为改为 `behavior: "auto"`（瞬时跳到底部）
  - 验收：思考阶段滚动平滑不抖

- [x] **T4-3** 添加用户手动滚动检测
  - 监听滚动容器的 scroll 事件
  - 如果用户主动向上滚动（距底部超过阈值），设置 `userScrolledUp = true`
  - 流式 delta 到来时检查该标志，为 true 则不自动滚动
  - 新消息加入时重置标志
  - 验收：用户上滚后不再被自动拉回底部
  - 自动化回归：`tests/unit/renderer/autoScroll.test.ts`

---

### T5 [P2] handleThinkingDelta / handleTextDelta 全量 messages.map 优化

**目标**：长对话流式阶段不出现主线程长任务（>50ms）。

- [x] **T5-1** 在 store 内添加 messageIndexById 索引
  - 文件：`src/renderer/stores/useAppStore.ts:544-573`
  - 新增 `messageIndexById: Record<string, number>` 字段
  - 每次消息数组变更时同步更新索引
  - 验收：索引与 messages 数组保持一致

- [x] **T5-2** 改造 delta 处理为索引直接更新
  - 文件：`src/renderer/stores/useAppStore.ts:544-573`
  - handleThinkingDelta / handleTextDelta 改为按索引直接切片更新：
    ```ts
    set(state => {
      const idx = state.messageIndexById[messageId]
      if (idx === undefined) return state
      const next = state.messages.slice()
      next[idx] = updateMessage(next[idx], delta)
      return { messages: next }
    })
    ```
  - 验收：delta 处理不再遍历全量消息数组

- [x] **T5-3** 性能验证
  - 构建 50 条历史消息 + 思考阶段的测试场景
  - 用浏览器 Performance 面板检查主线程长任务
  - 用 React Profiler 检查 ChatPanel 单次 commit 时间
  - 验收：无 >50ms 主线程长任务，commit 时间显著下降
  - 自动化回归：`tests/unit/renderer/phase3Performance.test.ts`
  - 验收记录：`tasks/phase3-validation.md`

---

## Phase 4：P3 体验打磨

### T6 [P3] ToolBox 中文映射与参数摘要

**目标**：工具卡片标题直观显示操作类型、目标文件/命令，不需要展开。

- [x] **T6-1** 补充工具中文名映射
  - 文件：`src/renderer/features/chat/ChatPanel.tsx:83-96`
  - 扩展 `getToolDisplayName` 覆盖以下工具：
    - `write` → `写入文件 (write)`
    - `edit` → `修改文件 (edit)`
    - `bash` → `执行命令 (bash)`
  - 验收：这三种工具显示中文名

- [x] **T6-2** 添加参数摘要逻辑
  - 文件：`src/renderer/features/chat/ChatPanel.tsx`
  - 在卡片标题旁显示摘要：
    - write: `正在写入 src/foo.ts（+N 行）`
    - edit: `正在修改 src/foo.ts（替换 N 行）`
    - bash: `正在执行 npm test`
    - read: `读取 src/foo.ts`
    - grep: `搜索 "TODO" 在 src/`
  - 摘要文字溢出时 CSS 省略号截断
  - 验收：不展开卡片也能看到核心操作信息

- [x] **T6-3** 调整术语用词
  - `入参 (Arguments)` → `调用参数`
  - `出参 (Result)` → `执行结果`
  - 验收：术语更贴近普通用户理解

---

### T7 [P3] ThinkingBlock 计时器精度

**目标**：思考时间显示不出现整秒跳动，主线程卡顿恢复后立即追上。

- [x] **T7-1** 改用 Date.now() 差值计时
  - 文件：`src/renderer/features/chat/ThinkingBlock.tsx:14-26`
  - 组件挂载时记录 `startTime = Date.now()`
  - setInterval 间隔从 1000ms 改为 100ms
  - 每次触发时计算 `(Date.now() - startTime) / 1000` 取一位小数
  - 移除 `seconds++` 递增逻辑
  - 验收：计时器单调递增，精度到 0.1 秒

- [x] **T7-2** 验证主线程卡顿场景
  - 模拟 LCS 计算等卡顿场景
  - 卡顿恢复后观察计时器是否立即追上真实时间
  - 验收：不出现"停一秒再跳两秒"

---

## Phase 5（可选/长期）

### T8 [P3，可选] 拆分 useAppStore 巨型 store

**目标**：每个 slice 文件 <300 行，单一职责。

> 此任务不急，可随日常开发逐步推进。

- [ ] **T8-1** 拆分 useChatStore
  - 负责：messages、isGenerating、currentGeneratingMessageId、send/cancel
  - 文件：`src/renderer/stores/useChatStore.ts`（新建）

- [ ] **T8-2** 拆分 useSessionStore
  - 负责：sessions、currentSessionId、selectSession、createNewSession、rollbackMessage
  - 文件：`src/renderer/stores/useSessionStore.ts`（新建）

- [ ] **T8-3** 拆分 useDiffStore
  - 负责：messageDiffs、loadingDiffs、loadMessageDiffs、accept/rejectFile
  - 文件：`src/renderer/stores/useDiffStore.ts`（新建）

- [ ] **T8-4** 拆分 usePermissionStore
  - 负责：pendingPermissionRequest、pendingVerificationRequest 及回应
  - 文件：`src/renderer/stores/usePermissionStore.ts`（新建）

- [ ] **T8-5** 拆分 useProjectStore
  - 负责：currentProject、currentMode、modelConfig、setMode、selectProject
  - 文件：`src/renderer/stores/useProjectStore.ts`（新建）

- [ ] **T8-6** 组合 useAppStore 门面（可选）
  - 作为对外统一入口，内部组合各 slice
  - 组件通过 selector 订阅，跨 slice 引用通过 `getState()` 拿快照

- [ ] **T8-7** 回归验证
  - 全量测试通过
  - 各组件 selector 改写后行数不增加
  - 每个 slice < 300 行

---

## 执行检查点

| 检查点 | 完成条件 | 验证方式 |
|---|---|---|
| CP1 — T1 完成 | DiffViewer 无 `+0 -0` 中间态 | 手动测试 + 单元测试 |
| CP2 — T2 完成 | 1MB 文件写入无卡顿 | 性能日志 < 50ms |
| CP3 — T3 完成 | cancel 后 session 无权限拒绝条目 | 集成测试 + 检查 session JSON |
| CP4 — T4+T5 完成 | 长对话流式无卡顿、滚动不抖 | Profiler 回归测试 + `tasks/phase3-validation.md` |
| CP5 — 全部完成 | 完整流程回归通过 | 创建会话 → 写大文件 → 观察 Diff → 取消 → 重新进入 |

---

## 每项通用验证

- `npm run test`（vitest）跑相关单元测试
- `npm run typecheck`（如果有）
- 手动跑"创建会话 → 让 Agent 写一个大文件 → 观察 DiffViewer → 取消 → 重新进入会话"完整流程

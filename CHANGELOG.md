# Changelog

## 2026-06-07

- **refactor**: 移除冗余的 `streamDeltaScheduler` 中间层，buffer 直连 store（Step 3）
  - 删除 `src/renderer/lib/streamDeltaScheduler.ts`（119 行）：rAF 聚合层与 `useStreamingRenderPool` 节奏叠加 1~2 帧，且 buffer 自身已按 16ms / 300ms 节流，再叠一层 rAF 收益不抵复杂度
  - 删除 `tests/unit/renderer/streamDeltaScheduler.test.ts`（186 行）
  - `src/renderer/App.tsx`：`createStreamDeltaBuffer` 的 onFlush 直接调 `useChatStore.getState().applyStreamDeltas(batch)`；清理函数里删 `flushStreamDeltasNow()` 与 `resetStreamDeltaScheduler()`；message-end / error / agent:tool-call 路径只剩 `buffer.flushNow()`，少 1 帧延迟
  - `src/renderer/stores/useChatStore.ts` / `useAppStore.ts`：清理 `@deprecated` 注释里对 `streamDeltaScheduler` 的引用，改写为「buffer 在 App 端直接喂批量 delta」
- **perf**: `StreamingFileCard` 流式期降级为纯文本 + `argumentsRaw` props 稳定化（Step 2）
  - `src/renderer/features/chat/StreamingFileCard.tsx`
    - props 改接 `argumentsRaw?: string`（primitive 字符串），配合 `useMemo` + `parsePartialToolArgs` 在内部解析为 `args`；保留 `args?` 字段作为旧调用方兼容回退
    - `running` 阶段不再调用 `highlightLine` 做 token 级高亮，每帧少 N 次正则匹配（CSS 大文件 200+ 行常见）；`success` / `error` 才一次性高亮，与 `MarkdownRenderer` 的 `isStreaming` 降级思路一致
    - `previewContent.split('\n')` 用 `useMemo` 缓存，避免每次重渲染重复 split
  - `src/renderer/features/chat/MessageItem.tsx`：渲染 `StreamingFileCard` 时同时传 `argumentsRaw` 与 `args`（block 已有字段，原样透传）
  - **测试**：新增 `tests/unit/renderer/StreamingFileCard.test.tsx`（7 用例）覆盖 running 不高亮、success 高亮、status 切换、partial JSON 解析、`argumentsRaw` vs `args` 兼容、edit 工具新 schema、memo 命中
- **perf/fix**: 消息级 `_revision` 精细 memo + 修复流式打字机与工具参数竞态
  - **消息级精细 memo（渲染瓶颈根因修复）**
    - `src/renderer/stores/types.ts`：`ExtendedMessage` 新增内部 `_revision` 字段（不持久化、不进 IPC）
    - `src/renderer/stores/useChatStore.ts`：新增 `bumpRevision()`，所有消息 mutate 路径统一 bump `_revision`，新建 / 恢复消息初始化为 0
    - 新建 `src/renderer/features/chat/MessageItem.tsx`：从 ChatPanel 抽出单条消息渲染，`React.memo(areEqual)` 只比 `_revision` 等 primitive/reference，流式期间仅当前生成的消息重渲染，历史消息整盘跳过
    - 新建 `src/renderer/features/chat/ToolBox.tsx` / `AssistantPendingIndicator.tsx`：从 ChatPanel 内联抽出
    - `src/renderer/features/chat/ChatPanel.tsx`：`messages.map` 改为渲染 `<MessageItem>`，回调用 `useCallback` 稳定引用；清理失效 import
    - `src/renderer/features/chat/StreamingTextBlock.tsx`：补 `React.memo`
  - **修复流式打字机首次挂载失效**：`src/renderer/hooks/useStreamingRenderPool.ts`
    - 流式中首次挂载时 `renderedLength` 从 0 起算（此前直接 = targetLength 导致 pool=0，打字机从未启动）；非流式仍直接显示完整内容
    - 默认 `requestFrame/cancelFrame` 提到模块级常量，避免 rAF tick effect 频繁重启
  - **修复工具参数竞态导致的「未命名文件」**（严重）
    - 根因：工具参数 delta 走 300ms 缓冲，最终 `agent:tool-call`（完整 args）走 store 直通；最终事件先写入完整 args 后，缓冲残留的 partial delta 才 flush 并用残缺解析覆盖，导致 `path` 丢失
    - `src/renderer/App.tsx`：`agent:tool-call` 处理前先 `buffer.flushNow()` + `flushStreamDeltasNow()`，再写完整 args
    - `src/renderer/stores/useChatStore.ts`：`applyStreamDeltas` 防御兜底——tool block 已 finalize（`argumentsRaw === undefined`）则跳过 partial 覆盖
  - **测试**：新增 `MessageItem.test.ts` / `revisionBump.test.ts` / `applyStreamDeltas` 竞态回归用例；对齐 `useStreamingRenderPool.test.ts` 首挂载断言

## 2026-06-06

- **refactor**: Store 拆分 + 流式输出优化 + 取消机制 + 渲染池 + Steering Queue
  - **Phase 1 Store 拆分**：1118 行 useAppStore.ts 拆为三个职责清晰的子 store + 兼容层
    - 新建 `src/renderer/stores/types.ts`：跨 store 共用类型（ExtendedMessage / ExtendedToolCall / RendererMessageBlock / PendingPermissionRequest / MessageDiffCache / SessionUsageStats 等）
    - 新建 `src/renderer/stores/useChatStore.ts`：消息 / 会话 / 消息索引 / 流式 handler / diff 缓存 / markRunningAsCancelled / applyStreamDeltas
    - 新建 `src/renderer/stores/useAgentStore.ts`：Agent 运行时 / 权限 / 取消 / 验证权限
    - 新建 `src/renderer/stores/useSettingsStore.ts`：ModelConfig / currentProject / currentMode / sessionUsage / contextLimit / isConfigModalOpen
    - 新建 `src/renderer/stores/selectors.ts`：跨 store selector（selectSupportsVisionFromConfig）
    - 改造 `useAppStore.ts` 为薄兼容层：setState 按字段归属分发到子 store；hook 形式订阅并合并三个子 store
    - `src/renderer/features/chat/ChatPanel.tsx`：所有 `useAppStore(state => ...)` 拆为从 useChatStore / useAgentStore / useSettingsStore 直接订阅
  - **Phase 2 数据层缓冲**：高频 SSE delta 改为批量写入，避免 kHz 级 React 重渲染
    - 新建 `src/renderer/lib/streamDeltaBuffer.ts`：时间窗口缓冲（文本 16ms / 工具参数 300ms），关键时点 flushNow；thinking→text 切换时自动 flushNow 避免块顺序错乱
    - 新建 `src/renderer/lib/streamDeltaScheduler.ts`：模块级 pending queue + rAF 聚合；新增 `scheduleStreamDelta` 统一 delta 入口，让 buffer 在 onFlush 中遍历 batch 投递，避免直接调 apply 绕过 rAF 层
    - `src/renderer/App.tsx`：thinking / text / tool-call-delta 三个高频事件改为走 buffer；message-end / error 前 flushStreamDeltasNow；handleMessageEnd 异常 catch 后不再静默吞掉
    - `useChatStore.applyStreamDeltas` 改为先按 messageId 聚合再处理（O(N²) → O(N) 数组拷贝）
  - **Phase 3 取消机制改造**：前端只发信号，不再手动擦状态
    - `src/runtime/agent/types.ts` / `src/runtime/agent/AgentLoop.ts`：`message_end` 事件新增 `interrupted?: boolean`，仅在 cancel 路径时携带
    - `src/shared/session/types.ts` / `src/runtime/sessions/types.ts` / `src/main/ipc/sessionMessageMapper.ts`：`Message` 与 `SessionMessage` 新增 `interrupted` 字段，持久化到 SessionStore 后下次加载 UI 仍能区分
    - `src/shared/ipc/types.ts` / `src/main/ipc/agentHandler.ts`：IPC `agent:message-end` 透传 `interrupted` 字段
    - `useChatStore.handleMessageEnd` 接受 `interrupted` 参数：中断时把该消息的 running tool 块标记为 error、清空 streamingToolArgs、标记消息 interrupted
    - `useAgentStore.cancelExecution` 改造为发信号 + 5s 兜底超时（仅当 currentGeneratingMessageId 仍是取消时那条才触发 markRunningAsCancelled，避免误杀 dispatchNextPending 派发的新消息）
  - **Phase 4 渲染池**：从"段落跳跃"改为"平滑打字机"
    - 新建 `src/renderer/hooks/useStreamingRenderPool.ts`：targetLength / renderedLength 双轨 + rAF tick，getCatchupStep 算法（小池固定 220 chars/s、中池 14%、大池 20%、超大量 28% 但不超过 3600 chars/帧）；支持 `agile` / `elegant` 两种风格
    - 新建 `src/renderer/features/chat/StreamingTextBlock.tsx`：封装 useStreamingRenderPool + MarkdownRenderer，render pool tick 时通过 `onRenderPoolTick` 回调通知外部
    - `src/renderer/features/chat/ChatPanel.tsx`：text block 渲染路径切换到 StreamingTextBlock；自动滚动从监听 messages 改为监听 render pool tick
  - **Phase 5 Markdown 优化**：`src/renderer/features/chat/MarkdownRenderer.tsx`
    - 提取模块级 `STATIC_MARKDOWN_COMPONENTS` 常量 + `REMARK_PLUGINS`，引用稳定
    - 关键修复：pre 组件移到 `useMemo` 内部拼装并把 `isStreaming` 闭包进 CodeBlock，确保流式期间代码块真正跳过 `highlightLine` 逐行 token 解析
    - CodeBlock 接受 `isStreaming` prop：流式期间纯文本展示，结束后正常高亮
  - **Phase 6 Steering Queue**：允许在 Agent 运行期间输入消息，turn boundary 自动 dispatch
    - `useChatStore` 新增 `pendingUserMessages: Array<{ text; images }>` 队列（上限 20 条）+ `enqueuePendingMessage` / `removePendingMessage` / `clearPendingMessages` actions
    - `handleMessageEnd` / `markRunningAsCancelled` 末尾调用 `dispatchNextPending`（async）：FIFO dequeue 队首消息并 sendMessage
    - ChatPanel textarea 在 isGenerating 期间不再 disabled，placeholder 提示"输入将进入排队队列"；新增 steering-queue 提示组件展示当前排队项
  - **测试**：新增 `streamDeltaBuffer.test.ts` (12) / `streamDeltaScheduler.test.ts` (8) / `applyStreamDeltas.test.ts` (9) / `useStreamingRenderPool.test.ts` (16) / `steeringQueue.test.ts` (7) / `cancelRaceCondition.test.ts` (2) / `AgentLoop.test.ts` +2 共 56 个新测试
  - 架构依赖方向：useChatStore / useAgentStore / useSettingsStore 通过 `getState()` 单向读跨 store；useAppStore 兼容层做合并视图，按 KEY_OWNERSHIP 表把 setState 分发到对应子 store
  - **代码审查后修复**：
    - C1：streamDeltaBuffer 的 onFlush 改为遍历 batch 调 `scheduleStreamDelta`，让 rAF 聚合层真正生效
    - C2：MarkdownRenderer 的 pre 组件从模块级常量移到 useMemo 内部，捕获 isStreaming 传递给 CodeBlock
    - I1：5s 兜底定时器检查 currentGeneratingMessageId 与取消时是否一致，避免误杀新消息
    - I2：补全 .steering-queue* CSS 样式（淡蓝虚线框、列表项、删除按钮）
    - I3：streamDeltaBuffer 增加 thinking→text 切换点检测，第一次 pushText 紧跟 thinking 时立即 flushNow
    - I4：App.tsx 改用 Promise.resolve(...).catch 包裹 handleMessageEnd 避免异步异常静默
    - I5：applyStreamDeltas 改为先按 messageId 聚合再统一处理消息引用，消除 O(N²) 数组拷贝
    - I6：useAppStore.setState 改为基于子 store 的 `Partial<ReturnType<typeof getState>>` 类型断言，移除 `as never`
    - S1：pendingUserMessages 上限 20 条防 OOM
    - S2：移除 StreamingTextBlock 的 data-render-pool-* debug 属性
    - S3：parseThinking 参数从 any 改为 `Pick<ExtendedMessage, 'id'> & { thinking?; content }` 精确类型
  - **第二轮代码审查后修复**：
    - C1-1：App.tsx 清理函数在 `buffer.flushNow()` 之后追加 `flushStreamDeltasNow()`，再 dispose / reset scheduler，确保 HMR / Strict Mode 二次 effect 之前最后一批 delta 不丢失
    - C1-2：`useChatStore` 的 `handleThinkingDelta` / `handleTextDelta` / `handleToolCallDelta` 在接口和实现处都标注 `@deprecated`，新代码必须走 `applyStreamDeltas` 路径
    - C2-1：ChatPanel.tsx 旧渲染路径（无 blocks 的消息）补上 `isStreaming={isCurrentAssistantGenerating}`，保证 API 契约完整
    - I1-1：5s 兜底定时器句柄保存到模块级 `cancelFallbackTimer`，`useChatStore.handleMessageEnd` / `markRunningAsCancelled` 完成后通过 `useAgentStore.clearCancelFallback()` 显式 `clearTimeout`，避免空跑 5s
    - I1-2：cancelledMessageId 为 null 时跳过启动兜底定时器（双击取消、刷新后立即点击场景）
    - I1 顺手：去掉冗余的 `+ 1000ms` 时间窗容差（定时器本身就是 5s 触发）
    - I5-1：`useChatStore.applyStreamDeltas` 的 toolCall 分支重构为一次性 `findIndex` 取出 toolBlock 与 partialArgs，避免在 `toolCalls.map` 里重复 `find` 两次 + 重复 `parsePartialToolArgs` 两次
  - **第二轮新增测试**：
    - `MarkdownRenderer.test.tsx` (新文件，4 测试)：C2 修复 — 验证 isStreaming=true 时代码块不输出 .diff-token span，isStreaming=false 时正常高亮；翻转时渲染路径正确切换
    - `useStreamingRenderPool.test.ts` +3：流式期间 fullText 持续增长时 tick 真正推进 renderedLength；追赶完成后再次增长 poolSize 重现非零；tick 单调递增不倒退
    - `applyStreamDeltas.test.ts` +3：混合 batch（多 messageId text + toolCall）一次 setState 各自合并；同 messageId thinking+text+toolCall 顺序保留；toolCallStart 后到的 text + toolCall delta 正确处理
  - **vitest.config.ts**：include 改为 `['tests/**/*.test.ts', 'tests/**/*.test.tsx']` 支持 tsx 测试
  - **第三轮审查后建议补全**：
    - `useAppStore.ts` 聚合接口中 `handleThinkingDelta` / `handleTextDelta` / `handleToolCallDelta` 补 `@deprecated` JSDoc（与 useChatStore 对齐），测试代码通过 useAppStore 调用时也能看到弃用提示
    - `App.tsx` 清理函数顺序调换：先解绑所有 IPC 监听器，再 flushNow → flushStreamDeltasNow → buffer.dispose → reset scheduler，避免清理过程中又有新 delta 进入
    - `cancelRaceCondition.test.ts` +4 测试：cancelledMessageId 为 null 时不启动兜底定时器；handleMessageEnd 正常完成后兜底定时器已被 clear；clearCancelFallback 单独调用是 no-op；markRunningAsCancelled 路径同样清除兜底定时器

## 2026-06-05

- **fix**: 修复 Windows 上 `edit` 反复报 "File has not been read yet" 引发的死循环、卡顿与渲染进程 OOM 白屏
  - `src/runtime/tools/editTool.ts`：`readState` 的 Map 键改为规范化键（`path.normalize` 折叠分隔符 + win32 转小写）。根因是 Windows 文件系统大小写不敏感，但 `read` 写入键与 `edit` 查询键可能因盘符/路径大小写（`D:\` vs `d:\`）不一致而错配，导致 `edit` 误判未读、模型陷入 `read→edit→失败→read` 无限重试
  - `src/runtime/tools/writeTool.ts`：`write` 成功后回种 `readState`（规范化内容 + 写入后 mtime），消除 `write → edit("未读取") → read → edit` 的多余往返；远程/自定义 ops 取不到本地 mtime 时静默跳过
  - `src/runtime/agent/AgentLoop.ts` + `src/runtime/agent/toolBatchExecutor.ts`：新增「相同工具调用（名称 + 参数一致）连续失败 3 次熔断」，命中后停止本轮并下发「已自动中断」提示，避免空转烧满 `maxToolRounds` 并向渲染端灌入海量事件；失败判定改用 `ToolExecutionOutcome.failed` 结构化标记（而非从中文 `resultText` 前缀反推），文案本地化不会让熔断失效，并能覆盖"未注册工具"等不以"工具执行失败"开头的失败；参数每轮不同（正常迭代修复）不会被误伤
  - `src/renderer/features/chat/MarkdownRenderer.tsx` / `StreamingFileCard.tsx` / `ThinkingBlock.tsx` / `ChatPanel.tsx(ToolBox)`：重型渲染组件加 `React.memo`。此前每个流式增量都会让全部历史消息重新做 Markdown 解析与逐行语法高亮，长循环下撑爆 Blink/Oilpan 堆导致白屏 OOM；memo 后仅当前活动消息重渲染
  - `src/renderer/features/chat/StreamingFileCard.tsx` / `partialJsonArgs.ts` / `toolDisplay.ts`：适配 `edit` 新 schema（`filePath` + `edits[].oldText/newText`），修复 edit 卡片显示「未命名文件」、文件名与新内容为空的问题，同时兼容旧 `path`/`old`/`new` 格式
  - `tests/unit/runtime/AgentLoop.test.ts` / `tests/unit/runtime/tools/editTool.test.ts` / `tests/unit/renderer/partialJsonArgs.test.ts`：新增熔断（含未注册工具）、`readState` 键大小写无关（win32）、`write→edit` 免读、edit 新 schema 解析共 8 个回归用例

- **feat**: 新增 `todo_write` 工具：把"当前计划"显式外化为会话级持久化状态
  - `src/shared/todo/types.ts` + `src/runtime/tools/todoView.ts`：`TodoItem` / `TodoViewInfo` 数据模型与紧凑视图算法（移植自 kilocode `TodoView.calculate`）
  - `src/runtime/tools/todoWriteTool.ts` + `src/runtime/tools/todoWriteDescription.ts`：模型可调用的 `todo_write` 工具，工具描述是模型行为的唯一合同，含 7 条"应该用"、4 条"不要用"反例与状态机规则
  - `src/runtime/sessions/types.ts` + `SessionStore.ts`：`SessionData` 新增 `todos` / `lastTodoWrite` 字段；`getTodos` / `updateTodos` 旧格式会话向后兼容
  - `src/runtime/tools/types.ts` + `src/runtime/agent/toolBatchExecutor.ts` + `AgentLoop.ts`：`ToolContext` 新增 `sessionStore?` / `sessionId?` / `eventBus?` 可选字段并透传，`AgentLoop` 新增 `setSessionContext` 注入接口
  - `src/runtime/agent/types.ts` + `src/shared/ipc/channels.ts` + `types.ts` + `agentHandler.ts`：新增 `todos_updated` 事件（不参与 AgentLoop 主流程状态机，仅给渲染端订阅）
  - `src/shared/session/toolVisibility.ts`：`todo_write` 归类为 `readonly`（写的是会话元数据，不动文件系统）
  - `src/runtime/tools/index.ts` + `agentHandler.ts`：`todo_write` 注册到 `ToolRegistry`
  - `src/renderer/features/todo/`：`useTodoStore`（按 sessionId 隔离）+ `TodoPanel`（full / compact 两种模式，含折叠信息行）+ `TodoItemRow`（状态图标 + 优先级 chip + 改行高亮）
  - `src/renderer/App.tsx` + `ChatPanel.tsx`：IPC 事件订阅链路 + 挂载到 `ChatPanel` 顶部
  - `tests/unit/runtime/tools/todoView.test.ts` + `todoWriteTool.test.ts` + `tests/unit/runtime/sessions/SessionStore.test.ts`（新增 todo 持久化用例）+ `tests/unit/shared/toolVisibility.test.ts` + `tests/unit/runtime/permissions/todoWritePermission.test.ts` + `tests/unit/runtime/EventBus.test.ts`（todos_updated 事件）+ `tests/unit/renderer/todo/useTodoStore.test.ts` 共 80 个新测试

- **Runtime**: 新增工具批量执行调度
  - 只读工具支持并发执行，写入和 shell 工具保持顺序
  - 工具结果事件可按完成顺序发出，但模型上下文仍按原始调用顺序写回
  - 补充并发、取消、权限和图片结果回归测试

## 2026-05-27

- **fix**: 收紧聊天流的视觉稳定性
  - `src/renderer/features/chat/ChatPanel.tsx`：assistant 消息开始但还没有文字、思考或工具调用时，显示“正在思考”等待态，不再出现空白气泡
  - `src/renderer/features/chat/ChatPanel.css` / `src/renderer/features/diff/DiffViewer.css`：assistant 消息改为稳定占满当前内容列，Diff 长行限制在内部横向滚动，不再撑出窗口
  - `src/renderer/features/chat/ThinkingBlock.tsx` / `src/renderer/features/chat/StreamingFileCard.tsx`：完成后不再自动收起，避免页面高度突然塌陷
  - `tests/unit/renderer/chatExperience.test.ts`：补齐等待态、思考块和流式文件卡片的回归测试

## 2026-05-25

- **fix(T1)**: DiffViewer 不再出现 `+0 -0` 中间态
  - `src/runtime/agent/types.ts` / `src/shared/ipc/types.ts`：`diff_update` 事件新增 `phase: 'live' | 'final'` 字段，区分占位信号与终值
  - `src/main/ipc/agentHandler.ts`：`emitLiveDiffUpdate` 改为只读 manifest 文件清单，不再调用 `buildMessageDiffState`，避免在事件循环里同步跑 LCS；并通过 `setImmediate` 异步调度，确保不阻塞当前 EventBus 调用栈
  - `src/renderer/stores/useAppStore.ts`：`handleDiffUpdate` 新增 phase 参数，live 阶段不写 `messageDiffs`，仅写 `loadingDiffs` 和 `loadingDiffPlaceholders`；`loadMessageDiffs` 不再因 live 占位被错误跳过
  - `src/renderer/features/diff/DiffViewer.tsx`：loading 分支渲染文件名 + spinner，不再显示统计数字
  - `src/renderer/features/chat/ChatPanel.tsx`：调整渲染优先级，loading 时优先显示骨架，避免空 hunks 触发 `+0 -0`
- **fix(T2)**: 异步化 emitLiveDiffUpdate 调度，并添加性能埋点
  - `[perf] tool_result → diff_update: {ms}` 日志，>50ms 时升级为 warn
- **fix(T3)**: cancel 时不再向 session 残留"权限拒绝"工具结果
  - `src/runtime/agent/AgentLoop.ts`：cancel() 用 `PermissionAbortedError` reject 挂起的权限请求，`checkPermission` 捕获后返回 `{ aborted: true }`，工具循环检测到后跳过 tool_result 与 context 注入
  - `src/main/ipc/agentHandler.ts`：新增 `markActiveStreamsCancelled` 与 `dropPermissionDeniedResiduals` 双重保险，message_end 时剔除"权限拒绝: 用户拒绝"类残留，但保留模式策略拒绝（plan 模式拒写工具）
- **test**: 新增/扩展回归测试
  - `tests/unit/main/liveDiffEmission.test.ts`：phase: live 行为、LCS 不重算、异步调度
  - `tests/unit/renderer/useAppStore.test.ts`：T1 全链路回归
  - `tests/unit/runtime/AgentLoop.test.ts`：cancel 期间不产生权限拒绝
  - `tests/unit/main/verificationPermissionFlow.test.ts`：兜底过滤覆盖

## 2026-05-24

- **fix**: 收紧 S14 验证权限请求的生命周期与状态清理
  - 修改 `src/main/ipc/agentHandler.ts`：验证权限请求增加 30 秒超时自动拒绝，并在取消执行时统一清理挂起请求
  - 新增 `verification_permission_cleared` 事件与 IPC 通道，避免 renderer 留下悬挂的验证确认 UI
  - 修改 `src/renderer/App.tsx` 与 `src/renderer/stores/useAppStore.ts`：超时、取消、切 session、创建新会话和删除会话时都会清理验证权限提示
  - 调整 `tests/unit/main/verificationPermissionFlow.test.ts` 与 `tests/unit/runtime/model/abortSignal.test.ts`：补齐超时清理回归测试并修正取消语义描述

## 2026-05-23

- **fix**: 验证权限确认接入真实 IPC 交互流程
  - 修改 `src/main/ipc/agentHandler.ts`：default 模式验证不再 `return true` 直接放行，改为通过 EventBus 发出 `verification_permission_request` 事件，等待 renderer IPC 回来的用户决策
  - 新增 `verification_permission_request` AgentEvent 类型和 IPC 通道
  - 新增 `respond-verification-permission` IPC handler，resolve 挂起的权限 Promise
  - 修改 `src/renderer/stores/useAppStore.ts`：新增 `pendingVerificationRequest` 状态、`handleVerificationPermissionRequest` 和 `respondVerificationPermission` actions
  - 修改 `src/renderer/App.tsx`：监听 `agent:verification-permission-request` 事件
  - 修改 `src/renderer/features/chat/ChatPanel.tsx`：展示验证权限确认 UI（允许/跳过）
  - 新增 `tests/unit/main/verificationPermissionFlow.test.ts`（4 个测试）：验证 permissionCallback 闭包的 EventBus 交互、用户允许/拒绝、事件流累积

## 2026-05-23

- **feat**: 补齐 Mini Coding Workbench 最小闭环（S14）
  - 新增 `src/runtime/agent/contextBuilder.ts`：从 session 历史恢复模型对话上下文，实现真正的多轮对话（user/assistant/tool/thinking 完整恢复）
  - 修改 `src/runtime/agent/AgentLoop.ts`：新增 `injectHistory()` 方法接收预组装历史上下文；调模型时传入 AbortSignal 实现真正的请求级取消
  - 修改 `src/runtime/model/ModelClient.ts`：chat() 接口增加 `ChatOptions` 参数（含 abortSignal）
  - 修改 `src/runtime/model/OpenAICompatibleModelClient.ts`：fetch 传入 signal，区分 AbortError 和 API 错误，流读取中检查 abort 状态
  - 修改 `src/main/ipc/agentHandler.ts`：发送消息前用 contextBuilder 恢复历史；消息完成后自动触发验证；验证摘要追加到 SessionMessage
  - 新增 `src/runtime/verification/`：验证服务模块（types/strategy/runner/service），按 test>lint>build 优先级探测并执行验证命令
  - 修改 `src/renderer/App.tsx`：监听 `agent:verification-result` 事件
  - 修改 `src/renderer/stores/useAppStore.ts`：ExtendedMessage 增加 verificationSummary，新增 handleVerificationResult handler
  - 修改 `src/renderer/features/chat/ChatPanel.tsx`：在 assistant 消息下展示验证结果摘要（成功/失败区分）
  - 修改 `src/runtime/sessions/types.ts`：SessionMessage 增加 verificationSummary 字段
  - 修改 `src/shared/session/types.ts`：Message 增加 verificationSummary 字段
  - 修改 `src/main/ipc/sessionMessageMapper.ts`：传递 verificationSummary 到 renderer
  - 新增 31 个测试（contextBuilder 9 + abortSignal 4 + verification 12 + regression 6）

- **fix**: S14 架构收口（代码审查修复）
  - 修改 `src/runtime/model/types.ts`：ChatEvent 增加 `cancelled` 事件类型，用户取消和 API 错误语义分离
  - 修改 `src/runtime/model/OpenAICompatibleModelClient.ts`：取消时发射 `cancelled` 而非 `error`
  - 修改 `src/runtime/agent/AgentLoop.ts`：对 `cancelled` 事件走独立分支，不进入 error 状态
  - 重写 `src/runtime/verification/service.ts`：服务自包含闭环，所有状态通过参数传入，不依赖全局变量
  - 新增 `src/runtime/verification/format.ts`：格式化逻辑独立，验证服务不堆在 agentHandler 里
  - 修改 `src/runtime/verification/types.ts`：新增 `PermissionCallback` 类型，default 模式需权限确认
  - 重写 `src/main/ipc/agentHandler.ts`：删除 5 个进程级全局变量，改用闭包捕获 + MessageContext 参数传递；hasModifications 改用 checkpoint manifest 判定而非工具名猜测
  - 新增 6 个测试（entryIntegration 4 + verification permission 2）

- **fix**: 收口 S13 的历史恢复、Plan 提示词与思考计时问题
  - 新增 `src/main/ipc/sessionMessageMapper.ts`：统一恢复持久化消息，历史会话重新加载时保留 `blocks`，并安全解析工具参数
  - 新增 `src/runtime/agent/modePrompt.ts`：按 mode 注入系统提示词，Plan 模式明确为只读规划模式，不再把完整实现正文当作写入替代
  - 修改 `src/runtime/agent/AgentLoop.ts`：隐藏工具调用继续回传拒绝结果给模型，但不进入 UI 事件流，避免空白或半截回复
  - 修改 `src/renderer/features/chat/ChatPanel.tsx` 与 `renderingPolicy.ts`：只有最后一个思考块继续计时，Plan 模式不渲染被策略禁止的写入工具卡，权限拒绝时隐藏 Arguments
  - 修改 `src/renderer/stores/useAppStore.ts`：旧会话兼容恢复时清理历史 `<think>` 标签，正文不再混入思考内容

- **feat**: S13 修复 Plan 工具暴露、思考泄露与顺序渲染
  - 新增 `src/runtime/model/ThinkTagParser.ts`：四态流式状态机，从 delta.content 中剥离 `<think'>...</think'>` 标签，正确产出 thinking_delta 和 text_delta，状态跨 chunk 保持
  - 修改 `src/runtime/model/OpenAICompatibleModelClient.ts`：delta.content 经过 ThinkTagParser 处理，流结束时冲刷缓冲区
  - 修改 `src/runtime/agent/AgentLoop.ts`：Plan 模式下只向模型暴露只读工具 schema，被禁止的工具调用不发射 tool_call 事件
  - 新增 `src/shared/session/types.ts` 中 ThinkingBlock/TextBlock/ToolBlock/MessageBlock 联合类型，Message 接口增加 blocks 字段
  - 修改 `src/renderer/stores/useAppStore.ts`：流式事件按顺序维护 blocks 数组，旧消息兼容构造 blocks
  - 修改 `src/renderer/features/chat/ChatPanel.tsx`：按 blocks 顺序渲染 thinking→text→tool→text，替代旧的分桶渲染
  - 修改 `src/main/ipc/agentHandler.ts`：StreamAccumulator 累积 blocks 并持久化到 SessionMessage
  - 新增 19 个单元测试（thinkTagParser 15 + toolFilter 4）

## 2026-05-21

- **feat**: 实现 S9 SessionStore + 回退能力
  - 新增 `src/runtime/sessions/types.ts`：会话类型定义（SessionSummary、SessionData、SessionMessage、SessionToolCall）
  - 新增 `src/runtime/sessions/SessionStore.ts`：会话持久化模块，支持创建/加载/列表/删除会话、追加消息
  - 新增 `src/runtime/checkpoints/restore.ts`：按文件拒绝（rejectFile）和按消息回退（revertToMessage），清理 checkpoint 目录和会话历史
  - 新增 `src/main/ipc/sessionHandler.ts`：会话管理和回退操作的 IPC handler（load-sessions、load-session、create-session、accept-file、reject-file、rollback-message）
  - 更新 `shared/session/types.ts`：新增 SessionDetail 类型（继承 Session + messages）
  - 更新 `shared/ipc/types.ts` 和 `channels.ts`：新增 create-session IPC 通道，load-session 返回 SessionDetail
  - 更新 `main/ipc/agentHandler.ts`：注入 CheckpointManager 和 SessionStore，每轮消息后保存会话快照
  - 更新 `main/ipc/registerHandlers.ts`：注册 sessionHandler
  - 更新 `renderer/stores/useAppStore.ts`：selectProject 通过 IPC 创建真实会话，selectSession 从后端加载历史消息，新增 rollbackMessage 和 rejectFile 方法
  - 新增 30 个单元测试（SessionStore 17 + restore 13）
  - 补齐流式 assistant 内容与工具结果的历史恢复逻辑，避免回退后把 arguments 误展示成 result
  - 新增 `SessionStore.updateMode()`，让会话 mode 真正持久化到磁盘，而不是只停留在主进程内存
  - 更新 `set-mode` IPC 契约，切换模式时同步写回当前会话；加载/创建会话时同步主进程 mode
  - 补充 5 个回归测试（SessionStore mode 持久化 2 个 + renderer 历史恢复/回退 2 个 + IPC 契约 1 个）

## 2026-05-21

- **feat**: 实现 S8 Settings UI（模型配置）
  - 新增 `src/runtime/model/config.ts`：配置持久化与校验的统一模块
    - `validateModelConfig`：字段级校验（baseUrl 必须 http/https 开头、apiKey 非空、modelId 非空），trim 前后空白
    - `saveModelConfig`：校验通过后持久化到磁盘，校验失败抛异常；返回 trim 后的合法配置
    - `loadModelConfig`：从磁盘加载配置，复用 `validateModelConfig` 做强校验，坏配置静默返回 null
  - 重构 `configHandler.ts`：去除冗余校验逻辑，统一由 `saveModelConfig` / `loadModelConfig` 负责校验和读写
  - 重构 `main/index.ts`：启动加载配置改用 `loadModelConfig` 模块，移除内联 fs 读写
  - 完善 `SettingsModal.tsx`：字段级错误展示、URL 格式校验、输入变化时自动清除对应错误
  - 修复 `OpenAICompatibleModelClient` URL 拼接：从 `/v1/chat/completions` 改为 `/chat/completions`，避免用户填写含 `/v1` 的 baseUrl 后请求打到 `/v1/v1/`
  - 新增 25 个单元测试覆盖：校验成功/失败/边界、配置读写/覆盖/容错、save 校验抛异常、load 校验拦截坏配置（缺 apiKey、空 apiKey、非法 URL）

## 2026-05-21

- **feat**: 实现 S7 PermissionManager + bashTool
  - 实现 `PermissionManager`：三模式权限决策引擎（plan deny / default ask / auto allow 危险 deny）
  - 实现 `rules.ts`：规则表 + 危险命令黑名单检测（Unix + Windows 双平台覆盖）
  - 实现 `permissions/types.ts`：权限查询、决策结果、风险等级类型定义
  - 实现 `bashTool`：Shell 命令执行，基于 `child_process.exec`，支持超时终止 + AbortSignal 取消
  - 更新 `AgentLoop`：集成权限判断，ask 模式发射 `permission_request`（含 messageId、riskLevel、reason）
  - 更新 `agentHandler`：注册全部 7 个工具、注入 PermissionManager、同步运行模式、注册 respond-permission IPC
  - 修复 IPC 类型 `permission_request` 补齐 messageId，risk 改为结构化（riskLevel + reason）
  - 新增 33 个单元测试（PermissionManager 23 个 + bashTool 10 个）
  - 补齐 renderer 权限确认弹窗与状态管理，允许/拒绝可回传 runtime
  - 修复 `bashTool` 取消只杀 shell 不杀子进程的问题，改为终止整棵命令进程树
  - 额外新增 5 个回归测试（AgentLoop 权限链路 2 个 + renderer 权限状态 2 个 + bash 后台子进程清理 1 个）

## 2026-05-21

- **feat**: 实现 S6 CheckpointManager + 写入工具
  - 实现 `CheckpointManager`：写前备份、manifest 管理、事务边界控制
  - 实现 `editTool`：精确字符串替换修改已有文件，支持歧义检测
  - 实现 `writeTool`：整文件写入/新建，自动创建目录
  - 更新 `AgentLoop`：集成 checkpoint 事务管理、plan 模式写入拦截
  - 扩展 `ToolContext` 类型，支持 checkpoint 注入
  - 新增 24 个单元测试（CheckpointManager 9 个 + 写入工具 15 个）

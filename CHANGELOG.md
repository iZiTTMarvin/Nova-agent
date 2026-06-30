# Changelog

## 2026-06-30

- **feat(session)**: 会话树模型阶段 1–3 + Tier 2 forward 快照
  - 数据：v4 `parentId` / `currentLeafId`、`tree.ts` 纯函数、`migrateV3ToV4`；`SessionStore.appendMessage` 自动挂 parent；上下文与分页走 active path
  - 分叉：`workspace:edit-resend`、`workspace:regenerate`、`workspace:switch-branch`；用户消息编辑、assistant 重新生成、翻页器 `‹ k/n ›`；`BranchMeta` 由主进程折叠下发
  - 刷新：`WorkspaceState.messagesRevision` 双轨策略（switch 立即 bump；edit/regenerate 流式结束后 `finishBranchMetaRefresh`）；`workspace:bump-messages-revision`
  - 文件：Tier 2 `forward/` 快照 + `revertWorkspaceForMessageIds`（非破坏性）+ `applyForwardForMessageIds`；切分支全额重放成功无 Tier 1 横幅；缺 forward 降级灰显 diff
  - 清理：删除 `rollback-message` / `workspace:rollback-message` 死代码
  - 测试：+6 用例（`forward.test.ts`、`WorkspaceService.branch.test.ts` 等）；全量 1585 通过
  - 详见 `docs/未来目标/会话树模型设计.md`；阶段 4（delete-branch / repair-forward / compaction 树）见 §18

- **fix(runtime)**: bash 命令退出码非零不再误判为工具故障，且失败时保留完整输出
  - 根因：`bash/index.ts` 的 `composeResult` 把退出码非 0 一律判为 `success:false`，而上层 `toolBatchExecutor` 在失败分支会**丢弃 output、只把 `命令退出码: N` 喂给模型**。导致 grep/findstr 无匹配、where 未找到、mvn 编译报错等情况下，模型看不到任何 stdout/stderr，只能盲目换命令反复重试
  - 改动 #1（`bash/index.ts`）：命令正常跑完、仅退出码非零时改为 `success:true`，并在 output 顶部加 `[命令退出码: N（命令已执行完成；非 0 不一定是错误，请阅读下方输出判断）]` 标注；超时 / 取消 / 信号终止 / spawn 失败仍为 `success:false`
  - 改动 #2（`toolBatchExecutor.ts`）：失败分支不再只回传 error 文案，将工具已产出的 output（如超时前的部分日志）附加在 error 之后，确保模型在真失败时也能拿到可用信息
  - 连带收益：业务性非零退出不再计入 `stopPolicyExtension` 的重复失败熔断，也不再被 UI 标红；真正的工具故障行为不变
  - 测试：更新 `bashTool.test.ts` 两条退出码用例，typecheck + bashTool/toolBatchExecutor/AgentLoop 共 68 用例通过

## 2026-06-29

- **feat(renderer)**: 会话消息显示分页（P1-c）
  - 进入会话仅渲染最近 20 条尾部消息；用户上滚到顶时按游标每次补载 40 条更早历史并 prepend，修正 scrollTop 避免视口跳动
  - 主进程 `LOAD_SESSION` 仍全量读盘用于上下文容量拆分，但返回 renderer 的 `SessionDetail.messages` 改为尾部子集 + `hasMoreMessagesAbove`
  - 新增 `load-session-messages` IPC 与 `SessionStore.loadMessagesPage`；用户上滚补载后暂停 `trimMessageWindow` 头部裁剪，恢复对超长会话早期历史的可访问性
  - 测试：SessionStore 分页、sliceMessagesPage、useChatStore loadOlderMessages；typecheck + build

- **fix(renderer)**: 修复 bash 权限确认期间工具卡片渲染卡顿
  - 根因：bash / 验证命令权限确认也会让 Agent 等用户决策，期间 `message_end` 不会触发、`isGenerating` 仍为 true；此前只有 askQuestion 会传入 `isPausedForInput` 暂停流式动画，权限等待态仍会让 `ThinkingBlock` / `useStreamingRenderPool` 按生成中状态运行
  - 修复：`ChatPanel` 将 `pendingAskQuestion`、`pendingPermissionRequest`、`pendingVerificationRequest` 统一折叠为“等待用户输入”暂停态，并只传给等待用户决策的目标消息；同时 `useStreamingRenderPool` 在待渲染字符池清空后停止 rAF，后续文本增长时再重新启动，避免空池每帧空转
  - 测试：补充 `ChatPanel.test.tsx` 的 bash 权限等待接线断言，补充 `useStreamingRenderPool.test.ts` 的空池停止 rAF 与增长后恢复断言

- **fix(renderer)**: 真正落地 askQuestion 卡死的接线修复 + 解除"面板开着发新消息"死锁（前序条目误标为已完成）
  - 勘误：上文 2026-06-29 `fix(renderer): 修复调用 askQuestion 后 UI 持续卡顿 / 卡死` 条目称 "`ChatPanel` 把 `isPausedForInput = pendingAskQuestion !== null` 传入 `MessageItem`"，但**该接线从未落地**——`MessageItem` 侧（prop / `streamingActive` / `areEqual` / 单测）已全部就绪，唯独 `ChatPanel.tsx` 渲染 `<MessageItem>` 时漏传 `isPausedForInput`。因此卡死现象实际未被修复，本次补上接线
  - 修复 #1（卡死主根因）：`ChatPanel` 渲染 `MessageItem` 时补 `isPausedForInput={!!pendingAskQuestion}`。等待用户回答期间 `streamingActive = isGenerating && !isPausedForInput` 为 false，`ThinkingBlock` 100ms 计时器与 `useStreamingRenderPool` 的 rAF 循环各自 cleanup 停转，消除渲染线程 churn（这正是"聊天区卡死、窗口仍能关/缩"的成因）
  - 修复 #2（隐蔽死锁）：用户在 askQuestion 面板仍开着时于输入框发新消息，旧实现只 `enqueuePendingMessage` 进 steering queue，而队列只在 `message_end` 时 drain、旧轮次又被未 resolve 的 askQuestion 阻塞 → 互等死锁。新增 `preSendGate`：发新消息前若有 pending askQuestion 先 `dismissAskQuestion`（resolve 空 answers），让旧轮次能正常走到 `message_end`，新消息照常 enqueue 等 turn boundary drain
  - 修复 #3（dismiss 后入队竞态）：`handleSend` 在 `await preSendGate()` 后若仍用本次 render 捕获的旧 `isGenerating` 决定 enqueue/send，会因 IPC 往返期间旧轮次已 `message_end`、`dispatchNextPending` 因队列为空提前 return 而错过 drain，新消息被塞进已结束的轮次队列、永久滞留。改为 await 后重读 `useChatStore.getState().isGenerating`：仍生成则 enqueue、已结束则直接 sendMessage
  - 缓存命中中性：本项目每次 `SEND_MESSAGE` 都 `dispose` 旧 loop 并从持久化历史重建 `context`，从不复用内存 loop；前缀缓存由 LLM 服务商按历史前缀命中。dismiss 路径让旧轮次正常完成（不 abort）、新消息走同一份历史重建，前缀不变，缓存不受影响
  - 测试：新增 `sendOrchestration.test.ts`（锁定 `preSendGate`：无 pending 不 dismiss / 有 pending 先 dismiss / 错误冒泡不静默吞）；新增 `ChatPanel.test.tsx`（接线测试：mock `MessageItem` 捕获 props，断言有 pending askQuestion 时收到 `isPausedForInput=true`、无 pending 时为 false——本次 bug 的本质就是接线漏传，故此测试是关键防线）；`MessageItem.test.ts` 补注释说明其只覆盖 `areEqual`、接线由 `ChatPanel.test.tsx` 保障。typecheck + 全量 1497 单测 + build 通过

- **feat(renderer)**: askQuestion UI 改造为底部 Dock + 工具状态卡片
  - 新增轻量工具状态卡片 `AskQuestionToolCard`，在消息流中显示 "询问用户 (askQuestion)" 运行/完成状态，不承载交互、不折叠、不暴露 JSON 参数
  - `AskQuestionPanel` 从消息流内部迁移为 composer 上方的 dock，复用 `chat-panel__composer-area` 布局并显式设置 `pointer-events-auto`
  - dock 形态精简 header：多题显示 `问题 N / M`，单题显示 `current.header` 或默认兜底；单题且非多选时选中选项后 120ms debounce 自动提交
  - `ChatPanel` composer placeholder 在提问期间变为"请先回答上方问题，再发送新消息（或输入排队）"，发送按钮逻辑不变以兼容 Steering Queue
  - 回归：保持 `isPausedForInput` 语义，`MessageItem.areEqual` 不新增 props；新增 `AskQuestionPanel` 10 个 renderer 单元测试
  - 验证：typecheck + build + 全量 1492 单测通过

- **fix(renderer)**: 修复调用 askQuestion 后 UI 持续卡顿 / 卡死
  - 现象：模型调用 askQuestion、提问面板打开等待用户回答期间，界面明显卡顿；性能录制显示满屏 `requestAnimationFrame` / `Recalculate Style` / React 调度器持续 churn（CPU 未打满但持续重渲染）
  - 根因：askQuestion 阻塞工具执行期间 `message_end` 不会触发，`isGenerating` 一直为 `true`，导致生成中消息的两个流式动画常驻循环永不停止——(1) `ThinkingBlock` 最后一个思考块 `active` 恒真，100ms `setInterval` 每秒 10 次重渲染（计时器还会一直往上涨）；(2) `useStreamingRenderPool` 的 rAF tick 无条件重排，即使待渲染池已空也每帧空转
  - 修复：引入"等待用户输入即暂停"语义。`ChatPanel` 把 `isPausedForInput = pendingAskQuestion !== null` 传入 `MessageItem`；`MessageItem` 用 `streamingActive = isGenerating && !isPausedForInput` 驱动流式动画（`isCurrentAssistantGenerating` / `isActiveThinkingBlock` / `parseThinking`），暂停时 `StreamingTextBlock` 收到 `isStreaming=false`、`ThinkingBlock` 收到 `active=false`，两个循环的 effect 各自 cleanup 停止。`isGenerating` 本身语义不变（轮次未结束、composer 仍显运行态、不显示回退按钮）。用户回答后暂停解除，流式动画对后续内容正常恢复
  - 测试：`MessageItem.test.ts` 新增 `isPausedForInput` 变化触发重渲染的回归断言；typecheck + 渲染相关单测全绿

- **fix(permissions)**: askQuestion 不再被误判为命令工具而要求"执行前确认"
  - 根因（与 2026-06-26 task/invoke_skill 修复同源）：askQuestion 在 `toolVisibility.ts` 未声明能力（落到 `unknown`），`rules.ts` 把 `unknown` 一律按 bash 处理 → default 模式下变成 `ask`，导致模型发起提问时先弹权限确认；同时 UI 因无显示名映射把卡片标题渲染成兜底的"运行自动化工具 (askQuestion)"
  - 修复：`toolVisibility.getToolCapability` 新增 `askQuestion` 分支归为 `readonly`（用户交互工具，无文件系统 / shell 副作用，所有模式直接放行、plan 模式可见可用）；`toolDisplay.ts` 补显示名"询问用户 (askQuestion)"与一句话摘要（取首题文本 + 多题题数）
  - 测试：`toolVisibility` 新增 askQuestion 归类回归用例，锁定不再退回 unknown；typecheck + 相关单测全绿

- **feat(agent)**: 新增 askQuestion 工具，模型可向用户结构化提问（多选项 / 单选多选 / 自定义输入 / 推荐项 / 多题向导）
  - 用途：模型遇到需要用户决策或补充偏好的场景时，调用本工具发起结构化提问，前端面板阻塞等待用户回答；用户回答后通过 IPC resolve 工具 Promise，模型收到格式化答案字符串继续推进
  - 阻塞链路复用 verification permission 模式（模块级 pendingMap + EventBus 推送 + IPC resolve）：`agentHandler` 维护 `pendingAskQuestions` Map，通过 `setAskQuestionHandler` 把"创建 Promise → 存 resolve → emit 事件 → IPC resolve"封装成回调，经 `AgentLoop.askQuestionHandler` → `toolBatchExecutor.buildToolContext` → `ToolContext.askQuestion` 透传进工具 execute
  - 三条兜底出口防止永久卡死：(1) 用户回答 / dismiss 走 `respond-ask-question`；(2) 用户在面板打开时发送新消息，`SEND_MESSAGE` 开头自动 guardFollowup 全部 dismiss；(3) 用户点击取消，`CANCEL_EXECUTION` 清理所有挂起请求
  - 子 agent 降级：`askQuestion` 回调只注入主 AgentLoop；task / skill fork 子 agent 不注入，工具 execute 命中降级路径返回 `askQuestion skipped: no askQuestion context.`
  - 改动文件：新建 `shared/askQuestion/types.ts`、`runtime/tools/askQuestionTool.ts` + `askQuestionDescription.ts`、`renderer/features/ask/AskQuestionPanel.tsx` + `.css`；修改 `tools/types.ts`、`agent/types.ts`、`shared/ipc/{channels,types}.ts`、`runtime/agent/AgentLoop.ts`、`runtime/agent/execution/toolBatchExecutor.ts`、`main/ipc/agentHandler.ts`（六处改动：模块级 Map + setAskQuestionHandler + forwardEventToRenderer + RESPOND_ASK_QUESTION + guardFollowup + CANCEL 清理 + 注册工具）、`renderer/stores/useAgentStore.ts`（5 个新方法 + reset 块补清空）、`renderer/App.tsx`（直接订阅 useAgentStore，不经 useAppStore 兼容层）、`renderer/features/chat/ChatPanel.tsx`（pendingVerificationRequest 块后追加面板渲染）
  - 验证：新增 13 个单元测试（5 个核心场景 + 8 个边界场景），全量 1477 用例通过；typecheck + build 双绿
  - 详见 `docs/askQuestion-落地方案.md`、`tasks/askQuestion工具落地todo清单.md`

## 2026-06-26

- **feat(permissions)**: bash 权限放行改为内联卡片，按钮直接长在命令卡片上（学 Windsurf）
  - 形态变更：去掉 composer 上方那张独立的浮动权限卡片，改为把「拒绝 / 允许 ▾」按钮直接渲染在消息流里对应命令卡片（ToolBox）底部，跟随消息一起滚动
  - 锚定机制：`permission_request` 事件新增 `toolCallIds` 字段，渲染层据此把放行条对应到具体卡片；一批连续 bash 合并授权时，按钮锚定到该批最后一张卡片，主按钮文案为「全部允许（N 条）」
  - 性能：ToolBox 通过 zustand selector 订阅，selector 命中返回稳定引用、否则返回 null，保证只有锚点卡片重渲染，其余卡片不受影响，符合轻量目标
  - 保留原有授权粒度下拉：仅本次 / 本会话 / 本项目永久 / 全局永久 / 始终拒绝
  - 删除已被取代的 `PermissionPrompt.tsx`/`.css`，新增 `InlinePermissionBar.tsx`/`.css`
  - 链路改动：`runtime/agent/types.ts`、`AgentLoop`、`permissionExtension`、`toolBatchExecutor`、`agentHandler`、`shared/ipc/types.ts` 透传 `toolCallIds`；typecheck 与权限/渲染相关单测全绿

- **fix(permissions)**: 派遣子代理 / 调用技能不再误触发权限拦截
  - 根因：`task`、`invoke_skill` 在 `toolVisibility` 里未声明能力（`unknown`），`rules.ts` 把 `unknown` 一律按 bash 类处理 → default 模式下变成 `ask`，导致派遣子代理 / 调用技能时弹出权限卡片（reason 还是通用的"命令执行"）
  - 本质：编排类工具本身没有文件系统 / shell 副作用，真正的副作用由子代理内部的 bash/write 各自走权限检查（经 `subAgentBridge` 桥接回父 UI）。在派遣层再拦一次属纯冗余，且与主流 agent 行为不一致
  - 修复：新增 `orchestration` 能力分类，`task`/`invoke_skill` 归入其中——default/auto 直接放行，plan 模式仍按非只读处理（deny + 隐藏，与现状一致，无回归）
  - 配套：`toolDisplay.ts` 给 `task`/`invoke_skill` 补显示名与头部摘要（展示子代理类型 / 技能名 + 任务摘要），卡片不再空白
  - 测试：`toolVisibility`、`PermissionManager` 新增编排类回归用例，全绿

## 2026-06-23

- **fix(agent)**: 工具调用方言改为 native 优先，根治 DeepSeek V4 DSML 泄漏与跨 provider 工具消息 400
  - 根因：旧策略对官方 OpenAI 兼容端点强制 inband XML，且只有一个通用 `<invoke>` 扫描器。DeepSeek-V4 输出原生 DSML（`<｜DSML｜invoke…>`），扫描器认不出 → 工具调用泄漏成正文、不执行。本质是层级错配：官方 `/chat/completions` 本就支持服务端函数调用，不该自己做 inband
  - `dialect.ts` 反转默认：native 优先，`XML_FORCED_FAMILIES` 收敛到仅 `ollama`；DeepSeek/Kimi/GLM/Qwen/MiniMax 官方端点统一走 native，由服务端解析各家格式（DSML 等）为结构化 `tool_calls`
  - 新增 `ModelConfig.toolDialect`（auto/native/xml）用户覆盖 + 设置 UI「工具调用方式」下拉，应对中转/本地端点
  - 空参护栏（`StopPolicyExtension`，`EMPTY_ARGS_LIMIT=2`）：连续多轮空参即中断并引导切 XML，替代旧的"全局退回 xml 防空转"
  - `sanitizeToolMessages`（发送前规整）：丢弃孤立 tool 消息、剥离无响应的 tool_calls，修复 Ollama→DeepSeek 切换后 `role 'tool' must be a response to...` 400
  - MiniMax 一致化：移出强制 xml 改走 native；inband 兜底加固 `MINIMAX_ARTIFACTS` 正则以识别 `<minimax:tool_call>` 命名空间外层，override 成 xml 时也不泄漏
  - 历史会话清洗：`stripLeakedToolMarkup` 在 `contextBuilder` 恢复 assistant 正文时剥离已泄漏的 DSML 残留，不破坏普通 `<`/`>` 代码
  - 测试：dialect / stopPolicy / contextBuilder / xmlToolScanner / toolFilter / serialization 同步更新，全量 1309 用例通过
  - 详见 `docs/工具调用方言根治方案-native优先.md`、`docs/DeepSeek-V4-DSML工具调用泄漏修复方案.md`

## 2026-06-20

- **Agent**: 最大工具调用轮数可配置，达到上限不再静默中断
  - 新增设置项 `maxToolRounds`（默认 100，范围 1~1000），可在「设置 → 通用」调整
  - 主 Agent 创建时从设置注入，替代写死的 20
  - 达到上限时下发提示文案，修复长任务“突然中止”无任何反馈的问题

## 2026-06-18

- **fix(agent)**: 根因修复——XML 方言下不应传 native tools 定义给模型
  - 真正根因：`AgentLoop` 不管 dialect 始终把 `tools` 作为 `body.tools`（native function calling 定义）发给 API。XML 方言的轻量模型（DeepSeek V4 Flash）同时收到 prompt 里"用 XML 格式调用"的指示和 API 层的 native tools 定义，两者矛盾导致模型混乱——模型被诱导走 native function calling 但能力不足以正确填充 `function.arguments`，返回空 `arguments: "{}"`，触发「缺少参数」死循环
  - 诊断证据：日志显示 `dialect: xml`，5 个 read 的 `arguments` 全是 `"{}"`，正文只有 19 字符普通文本（无 XML），reasoning 为空。模型完全没走 XML 路径，而是尝试 native 但填充失败
  - 修复：`AgentLoop.ts` 在 XML 方言下不传 `tools` 给 `modelPool.chat`（`nativeTools = dialect === 'xml' ? undefined : tools`）。工具定义仍在 system prompt 文本里恒定提供（由 `renderToolInventory` 渲染），不影响缓存 harness；强制模型走 XML 正文路径，消除 native tools 定义带来的混乱
  - `AgentLoop` 构造函数改进：从 `ModelClient.config` 读取 `modelId`/`baseUrl` 用于 dialect 判定（此前硬编码 `'primary'`，导致生产环境 modelId 丢失、dialect 可能误判）
  - `toolFilter.test.ts` 适配新行为：XML 方言断言不传 native tools（`undefined`），新增 native 方言（modelId='gpt-4o'）传全部 tools 的测试
- **fix(agent)**: 治本修复 native 协议下工具调用频繁报「缺少 path/filePath 参数」（前序修复，防御纵深保留）
  - 根因：部分模型 / 中转服务在 native function calling 协议下，把模型生成的 XML 工具调用原样塞进 `function.arguments` 字段且未做 JSON 转义。前端 `JSON.parse` 后 args 结构彻底错位——key 变成 `invoke name="edit"`、闭合标签残片 `/path`，value 是未闭合的 XML 片段。工具拿不到参数，报「缺少 path 参数」
  - 之前所有 XML 适配（`787b550` / `aaed462`）都只覆盖 XML inband 方言路径（`xmlToolScanner.ts`），完全没碰 native 路径；dialect 判定又会被含 `openai.com` 的中转 baseUrl 强制判成 native，导致换模型也踩同一坑
  - 新增 `src/runtime/agent/nativeArgsRepair.ts`：在工具执行前对 args 做检测与重解析。`needsRepair` 识别坏数据（含 XML 标签、非法 key）；`repairNativeArguments` 复用 `XmlToolScanner` 把损坏字符串重解析成结构化 args，取同名调用覆盖；`closeUnclosedParameters` 预处理未闭合的 `<parameter>`（真实模型常吐残缺 XML）；`coerceJsonLikeValues` 把数字 / 布尔 / JSON 数组字符串还原成对应类型，对齐 `parseXmlToolCalls` 行为
  - 接入点 `src/runtime/agent/toolBatchExecutor.ts:382`：`parseArgs` 之后、权限检查 / hook / 执行之前，确保下游全部拿到正确 args
  - 无法修复时保持原状，不破坏正常流程；对正常 native JSON 调用零开销短路
  - 第二层防御 `repairEmptyArgsFromContent`（AgentLoop 执行前）：覆盖"模型把参数写在 assistant 正文而非 function.arguments"的情况——toolCall.arguments 为空 `{}` 时，从正文扫描同名 XML / JSON 代码块调用补全；严格按工具名匹配，不 fallback（避免把 read 的参数塞给 bash）；清空补全后的正文残留避免 XML 标签展示给用户
  - 第三层修复（参数名别名兼容，直击"只有 read 失败"根因）：readTool / writeTool 此前只取 `args.path`，而 editTool 有 `filePath / path / file_path / file / filename / target_file / target` 七别名兼容。模型把路径放在 `file_path` 等别名下时，edit 能救、read 直接报「缺少 path 参数」——这就是为什么只有 read 失败、其他工具正常。给 readTool / writeTool 补齐与 editTool 一致的别名兼容，`path` 仍优先
  - 新增 `tests/unit/runtime/agent/nativeArgsRepair.test.ts`（27 例）；`readTool.test.ts` 补 8 例别名兼容测试；`toolBatchExecutor.test.ts` 补 3 个端到端集成测试

## 2026-06-17

- **fix(streaming)**: XML 方言模型（DeepSeek/GLM/Kimi/Qwen/MiniMax）写文件时文件卡片恢复逐字流式渲染
  - 根因：这些模型把工具调用以 `<invoke><parameter>` 写在正文里，SSE 只有 `text_delta`；旧逻辑在流式结束后对整条正文做一次全量解析，只 emit `tool_call` 终态，从不发 `tool_call_delta`，导致前端文件卡片等整条回复结束才一次性弹出
  - 把 `src/runtime/agent/xmlToolScanner.ts` 从「全量正则解析器」重写为「增量状态机」：`feed()` 逐块产出 `text` / `toolStart` / `toolArgDelta` / `toolEnd` 事件，buffer 只保留未确定语义的尾部，标签跨 chunk 切断、参数值跨 chunk、XML entity、MiniMax 占位符均正确处理；收紧规则——仅匹配 `invoke/parameter` 已知标签名，正文中的 `<div>` / `<T>` 不被误判
  - `src/runtime/agent/AgentLoop.ts` 流式循环接入扫描器：`text_delta` → `scanner.feed()`，把事件转成现有 `tool_call_start` / `tool_call_delta` / `tool_call`，前端零改动复用 `argumentsRaw` 流式通道；参数增量用 `JSON.stringify(delta).slice(1,-1)` 重新序列化为 JSON 片段，拼起来是合法 JSON；正文剥离标签，`assistantContent` 只含纯正文
  - 工具执行依据用 scanner 最终权威值：`ChatToolCall.arguments`（`executeToolBatch` 据此执行）取 `scanEvent.arguments` 而非流式片段拼接——entity（`&lt;` 等）被 SSE token 边界切开时，流式片段逐段转义会累积成字面 `&lt;`，而 scanner 的 `finalDecodeArgs` 在 `toolEnd` 时正确还原成 `<`，避免写入文件内容损坏
  - native 路径（Claude/GPT）完全不触发扫描器，零影响；XML 方言保留全量解析兜底补漏，scanner 已识别的调用不会重复 emit
  - 新增 `tests/unit/runtime/agent/agentLoopXmlStreaming.test.ts` 端到端集成测试（13 例，含 entity 跨 chunk 切分的执行数据正确性守护）；`xmlToolScanner.test.ts` 改造为增量测试（45 例，含逐字符 feed、chunk 切断、entity、兜底等价性）

- **fix(composer)**: 修复选中 skill 后无法发送带参数消息的问题
  - `SkillAC` 的 `/` 自动补全浮层此前只要输入以 `/` 开头且能匹配候选就一直打开；选中 skill 后继续输入参数时，每次 Enter 都被浮层拦截并把输入框重置回 "/skillname "，导致参数被吞、消息永远发不出去
  - 进入参数阶段（输入出现任意空白字符）后即关闭浮层，Enter/Tab 回归发送路径；纯 slash 命令阶段的选中能力不变
  - 新增 `tests/unit/renderer/SkillAC.test.tsx` 交互层回归测试，覆盖纯命令选中、参数阶段不拦截、Tab 与多行等场景

## 2026-06-15

- **fix(agent)**: 收口 session context v4 —— 修复工作区锚点误判、旧会话错误 prompt 迁移与 compaction 提示真实下发
  - `AgentLoop` 改为按完整 session-context 前缀逐字节比对锚点，只扫描 user 消息，避免 working directory 前缀子串误判与 assistant/tool 回显误命中
  - `agentHandler` 对已知旧版 `frozenSystemPrompt` 做定点归一化，避免历史会话继续沿用缺失或错误的 session context 文案
  - `OpenAICompatibleModelClient` 新增受控 `includeInternalMessages` 选项，允许 compaction 临时提示正文进入真实 API，同时继续剥离 `internal` 字段
- **test**: 补充 session context 跨天重注、前缀路径切换、compaction 真实发送与 legacy prompt 归一化回归测试
- **feat(agent)**: 根据模型方言选择工具调用格式，彻底修复 MiniMax-M3 等国产模型工具调用失败
  - 新增 `src/runtime/model/dialect.ts`：Claude / GPT / o 系列走原生 `tool_calls`；MiniMax / Kimi / GLM / DeepSeek / Qwen / 未知模型走 XML inband
  - 新增 `src/runtime/agent/xmlToolScanner.ts`：从 assistant 正文中扫描 `<invoke name="..."><parameter name="...">...</parameter></invoke>`，并清理 MiniMax `]<minimax>[` 占位符
  - 新增 `src/runtime/agent/toolPromptRenderer.ts`：根据方言渲染 system prompt 中的工具目录（native 只列名；xml 给出完整 XML 调用示例和规则）
  - 重写 `src/runtime/agent/modePrompt.ts`：`buildStableSystemPrompt()` 按方言、工作区、工具定义动态生成 prompt，并继续归一化已知旧版错误 prompt
  - 更新 `src/main/ipc/agentHandler.ts`：创建 AgentLoop 前按当前模型方言生成 system prompt
  - 更新 `src/runtime/agent/AgentLoop.ts`：流式响应结束后优先用 XML scanner 解析正文工具调用，保留 JSON fallback 作为兜底
  - 更新 `src/renderer/stores/useChatStore.ts`：前端清理 MiniMax 占位符和行内伪工具调用，避免界面乱码
  - 新增单元测试：`xmlToolScanner`、`dialect`、`toolPromptRenderer`；更新 `modePrompt` 测试

## 2026-06-14

- **fix(agent/checkpoints)**: 全面 bug 修复 15 项（C1–C6 / I1–I5 / S1/S2/S4/S5），覆盖数据丢失、资源泄漏、安全边界、状态隔离四类
  - **P0 数据丢失**
    - C1 压缩保留工具结果：`onCompaction` 把独立 tool 消息的内容合并回 `SessionToolCall.result`，避免重启加载时 `contextBuilder` 跳过 tool message 触发 OpenAI 400
    - C4+ 空闲压缩 abort 不再覆盖用户新消息：`runCompaction` 增加 `abortSignal` 参数，在替换 context / 调 onCompaction 前检查；移除 `prevContext` 快照回滚逻辑
    - C2 bash 流二进制损坏：snapshot 改 Buffer 读取、`recordBashChange` 接收 Buffer、`restore.ts` 全部去掉 utf8 编码读写，二进制文件字节级回退
  - **P1 资源生命周期 + 安全边界**
    - C3 subLoop 资源释放：`AgentLoop` 新增 `dispose()`（cancel idleTimer、reject pending permissions），task / skillFork finally 调用
    - C5 bash workdir 边界校验：`resolveWorkdir` 用 `relative + isAbsolute` 拒绝越界（绝对路径 / `..` 前缀）
    - C6 zip bomb 防护：`extractZip` 加文件数 / 总大小累计上限；`downloadHttpsToFile` 流式下载 + Content-Length 预检 + 超限清理
  - **P2/P3 状态隔离**
    - I1 `readState` 从模块级单例改为 `ToolContext` 实例字段（参考 Claude Code `ToolUseContext.readFileState`）：`toolBatchExecutor` 注入，sub agent 用 `clone()` 深拷贝
    - I2 `ROLLBACK_MESSAGE` 回退后清空 readState：避免陈旧快照误导后续 edit 校验
    - I3 创建新 AgentLoop 前 `dispose()` 旧的，避免遗留 IdleCompressionTimer
    - I4 危险命令黑名单补 `--recursive` / `eval` / `source` / 反引号替换执行
    - I5 `onCompaction` 中 sessionStore.load 失败时 `console.error`，不再静默丢压缩
  - **P4 体验**
    - S1 error / cancel 状态下不启动 idleTimer，避免后台压缩污染状态
      - catch 异常 / finishMessageRound cancel：不启动
      - fork 错误 / context_overflow 失败 / 模型错误重试耗尽：全部取消已存在的 idleTimer，避免之前后台残留 timer 触发
    - S2 `waitForChildProcess` 改监听 `close` 事件，去掉 100ms 经验延迟，30s 安全兜底
    - S4 `contextBuilder` 在 `tc.result === undefined` 时打 warning，方便发现 C1 类 bug
    - S5 `UNIMPLEMENTED_FIELDS` 提示仅 dev 环境显示，生产静默
- **test**: 新增 10 个 regression test（C2 二进制回退、C5 workdir 边界、C6 zip bomb、I1 readState 隔离 + clone、S1 error/overflow 不启动 idleTimer + 正常路径基线），全部 1005 测试通过

## 2026-06-12

- **feat(third-party-skills)**: Task 13 — Claude Code 技能只读同步至 `~/.nova/imported/claude-skills/`；`loadThirdPartySkills` 开关（默认开）；优先级 `project > global > third_party_claude > builtin`
- **feat(skill-create)**: Task 7 — `CreateSkillDialog`（slug 校验、description 计数、blank/new/onboard 模板、全局/项目位置）；IPC `skill:get-body`
- **feat(skill-import)**: Task 8 — `SkillService.import`（zip 解压 + https URL 30s 超时）；`SkillImportBar`（选文件/拖拽/URL）；IPC `skill:pick-import`；CLI `scripts/install-skill.mjs` / `scripts/package-skill.mjs`
- **chore(deps)**: 新增 `yauzl`、`gray-matter`（zip 解压 + YAML frontmatter）
- **fix(skills)**: frontmatter 改用 gray-matter/js-yaml + Kilo 式 fallback，修复第三方 skill（如 autoplan）description 块标量/冒号值解析
- **feat(settings)**: Task 5 设置弹窗改版 — 左右布局（56rem 固定高度）/ Rules / Skills / Subagents 四区；IPC `settings:*` / `rules:*` / `subagents:*`；左下角入口改名为「设置」
- **feat(skillac)**: Task 6 SkillAC — `/` 自动补全 Portal 浮层，Nova 暖色主题，评分 100/80/60（字符回退要求 query 全字符命中）

## 2026-06-11

- **feat(skills)**: Task 3/4 — 内置技能 + SkillService IPC
  - 内置 4 个核心 skill（`onboard` / `skill-creator` / `skill-add` / `new`）置于 `.nova/skills/`，构建时复制到 `out/main/.nova/skills`
  - `SkillService` 单例：`load/reload/list/create/delete/toggle`；启停持久化 `~/.nova/skill-state.json`；`import/export` 暂为 stub
  - IPC `skill:*` + preload `window.nova.skill`；应用启动即加载 builtin，工作区切换自动 reload 并推送 `skill:changed`
  - `ChatPanel` 改用 `window.nova.skill`；移除已无调用方的 `list-skills` 通道
  - 新增 `npm run validate:skills` 校验内置 skill frontmatter
- **fix(ui)**: Recovery 管线审查修复 — `recovery_state` IPC 截断 `snapshot`（`RendererRecoveryState`）；`RecoveryBanner` 补充 `failed` 状态；`handleError` 同步清理恢复状态（error 路径无 message-end）
- **feat(ui)**: Agent 事件管线 UI — Hook 错误与 Recovery 恢复状态接通渲染端
  - IPC 新增 `agent:hook-error`、`agent:recovery-hint`、`agent:recovery-state` 三通道；`agentHandler.forwardEventToRenderer` 映射 runtime 事件
  - `useChatStore` 新增 `recoveryState` / `recoveryHints` / `hookErrors` 及对应 handler；`message-end` 时按 messageId 清理
  - 新建 `RecoveryBanner`：重试（橙色）、上下文压缩（蓝色）、Hook 异常（警告色）；集成于 `ChatPanel` 输入框上方（对齐 Cursor / Windsurf composer 状态条）
  - 补充 `forwardEventToRenderer` 与 store handler 单测

## 2026-06-10

- **feat(hooks)**: 实现 9 事件 `HookManager` 并接入 `AgentLoop` 主循环
  - 新增 `src/runtime/agent/HookManager.ts`：顺序执行 / 提前退出 / 累积 patch / 顺序变换四种策略，handler 异常 swallow
  - `AgentLoop` 在 message_start、beforeAgentStart、context、preChat、preToolUse、postToolUse、postMessage、onError、onCancel 锚点注入 hook
  - `toolBatchExecutor` 支持 `preToolUse` 拦截与 `postToolUse` 结果变换
  - `types.ts` 新增 `hook_error` 事件；`agentHandler` 启动时注册 `onMessageStart` 示例日志
- **feat(skills)**: 实现 `SkillRegistry` + `invoke_skill` 工具 + 系统提示词注入
  - 扫描 `~/.nova/skills` 与项目 `.nova/skills`，frontmatter 解析，`buildSkillContext` 注入 `<skills>` 段
  - slash 命令 `/name` 展开为自然语言提示（由 LLM 主动调 `invoke_skill`）；`ChatPanel` 输入 `/` 时展示候选下拉
- **feat(agent)**: 6 层 `SystemPromptBuilder` + `RecoveryStateMachine`（继续/重试/恢复三态）
  - `projectRulesDiscovery` 扫描 AGENTS.md / CLAUDE.md / .cursorrules
  - 模型临时错误指数退避重试；context overflow 走 recovering + `recovery_hint` 事件
- **feat(agent)**: 内置 explore/code 子代理 + `task` 工具 + 三层隔离
  - `SubAgentConfig` 内置规格 + `~/.nova/subagents/*.json` 自定义
  - `task` 工具串行执行；子代理隔离 ToolRegistry / PermissionManager / Checkpoint（不注入 checkpoint）
  - 子 EventBus 收集摘要；`permission_request` 经 `subAgentBridge` 以 `sub:` 前缀转发父 UI 并路由响应
  - `SubAgentPermissionBridge` 实例级绑定；task 结束 / cancel 时 `clearForLoop` / `clear`

## 2026-06-08

- **perf**: 渲染进程 OOM 防护 — 截断 + 折叠 + LRU 裁剪 + 按需加载
  - `StreamingFileCard.tsx`：running 时自动展开，完成后自动折叠；超过 240 行截断展示
  - `DiffViewer.tsx`：hunk 超过 500 行截断；pending 状态自动展开
  - `useChatStore.ts`：消息窗口 LRU 裁剪（240 条上限，保留尾部 80 条）；流式 delta 原地 `+=` 拼接减少 GC；取消 `selectSession` 全量预加载 diff，改为 `MessageItem` 挂载时按需加载
  - `highlightCache.ts`：`highlightLine` 结果的 LRU 缓存（2000 条上限），避免重复语法高亮计算
  - `streamDeltaBuffer.ts`：简化为单 timer + 16ms 文本 / 300ms 工具参数两级节流

## 2026-06-07

- **refactor**: MessageItem 让 `StreamingFileCard` 的 `argumentsRaw` / `args` 通道互斥传递（Step 2 收尾）
  - `src/renderer/features/chat/MessageItem.tsx`：渲染 `StreamingFileCard` 时根据 `block.argumentsRaw` 是否存在二选一传 `argumentsRaw` 或 `args`，不再同时传两份。让组件级 `React.memo` 在流式期严格命中（仅当 `argumentsRaw` 字符串变长才失效），finalize 时 `argumentsRaw` 字段被 store 删掉自动切换到 `args` 通道，只在那一帧触发一次重渲染
  - `src/renderer/features/chat/StreamingFileCard.tsx`：把 `StreamingFileCardProps` 改为 `export`，让 MessageItem 可以基于类型构造互斥的 props 对象（类型层面就保证两个通道不会同时存在）
  - **测试**：在 `StreamingFileCard.test.tsx` 新增 2 个用例（流式期同 `argumentsRaw` 引用 memo 命中、完整闭合的 `argumentsRaw` 正确解析且不高亮）
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

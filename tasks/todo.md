# 流式工具调用渲染（Streaming Tool Call）Todo 清单

> 基于 `STREAMING_TOOL_CALL_PLAN.md` 拆解
> 生成日期：2025-05-26
> 目标：write/edit 工具在模型流式产出参数期间，UI 立刻出现写入文件卡片，等宽字体逐行刷出代码并自动滚动到底部。

---

## Phase S1：模型层 + Agent 层 + IPC 层（数据通路）

> 建立从 SSE 到 renderer 的完整增量事件通路，不做 UI 层改动，现有功能不受影响。

### S-T1 模型层：SSE 工具调用增量同步 yield

**目标**：SSE 流中 `delta.tool_calls` 的 `arguments` 增量实时 yield 给下游，不再等流结束才一次性发出。

- [x] **S-T1-1** 扩展 ChatEvent 类型
  - 文件：`src/runtime/model/types.ts`
  - 在现有变体基础上新增 `tool_call_start`（携带 toolCallId、toolName、index）和 `tool_call_delta`（携带 toolCallId、argumentsDelta）
  - 保留现有 `tool_call` 变体不变（它仍是"参数齐全可执行"的信号）
  - 验收：TypeScript 编译通过，现有代码不受影响

- [x] **S-T1-2** 修改 OpenAICompatibleModelClient 增量 yield 逻辑
  - 文件：`src/runtime/model/OpenAICompatibleModelClient.ts:137-159`
  - 在 `delta.tool_calls` 处理块中：收到第一个含 `id` 的 chunk 时，立刻 yield `tool_call_start`，如果有初始 arguments 片段也 yield `tool_call_delta`
  - 后续 chunk 有 `function.arguments` 时，yield `tool_call_delta`
  - 末尾一次性 yield 完整 `tool_call` 的逻辑**保持不动**
  - 验收：mock SSE 多 chunk 场景下，yield 序列为 `tool_call_start → tool_call_delta×N → tool_call`

- [x] **S-T1-3** 编写 S-T1 单元测试
  - 文件：`tests/unit/runtime/model/streamingToolCall.test.ts`（新文件）
  - mock fetch 返回多 chunk SSE，断言 ChatEvent 序列含正确顺序
  - 包含：单工具调用、多工具并发调用、第一个 chunk 不带 name 的边缘场景
  - 验收：测试通过

---

### S-T2 Agent 层：透传 + mode 隐藏过滤

**目标**：AgentLoop 透传流式工具调用事件，mode 隐藏的工具只进 toolCalls 数组不 emit 给 UI。

- [x] **S-T2-1** 扩展 AgentEvent 类型
  - 文件：`src/runtime/agent/types.ts`
  - 在 `tool_call` 之前新增 `tool_call_start`（含 messageId、toolCallId、toolName）和 `tool_call_delta`（含 messageId、toolCallId、argumentsDelta）
  - 不透传 index，renderer 用 toolCallId 定位
  - 验收：TypeScript 编译通过

- [x] **S-T2-2** 修改 AgentLoop 流循环处理
  - 文件：`src/runtime/agent/AgentLoop.ts:196-242`
  - 在 `case 'tool_call':` 之前新增 `case 'tool_call_start'` 和 `case 'tool_call_delta'`
  - mode 隐藏的工具加入 `hiddenToolCallIds` Set，delta 阶段检查该 Set 跳过 emit
  - 现有 `case 'tool_call'` 保持不动
  - 验收：plan mode 下 write/edit 的 start/delta 不 emit，但 tool_call 仍正常执行

---

### S-T3 IPC 层：channel 注册 + 转发

**目标**：新增 IPC channel 将流式事件转发给 renderer，不影响持久化逻辑。

- [x] **S-T3-1** 新增 channel 常量
  - 文件：`src/shared/ipc/channels.ts`
  - 新增 `AGENT_TOOL_CALL_START = 'agent:tool-call-start'` 和 `AGENT_TOOL_CALL_DELTA = 'agent:tool-call-delta'`
  - 验收：常量可供 import

- [x] **S-T3-2** 扩展 IpcEvents 类型
  - 文件：`src/shared/ipc/types.ts`
  - 紧挨 `agent:tool-call` 新增两个事件类型定义
  - 验收：TypeScript 编译通过

- [x] **S-T3-3** 修改 forwardEventToRenderer
  - 文件：`src/main/ipc/agentHandler.ts:535-591`
  - 在 `case 'tool_call':` 之前新增 `case 'tool_call_start'` 和 `case 'tool_call_delta'` 转发分支
  - 验收：renderer 可收到流式事件

- [x] **S-T3-4** 确认 accumulateStreamEvent 不变
  - 文件：`src/main/ipc/agentHandler.ts:210-308`
  - 确认增量事件不写 stream（持久化只关心最终完整 tool_call）
  - 在 switch 上方加一行注释说明此意图
  - 验收：会话历史不包含流式增量数据

---

## Phase S2：Renderer 状态层 + 参数解析

> store 接收流式事件并维护 UI 状态，partial JSON 解析器提取 write/edit/bash 的关键字段。
> **执行顺序**：S-T5（解析工具）必须先于 S-T4-3 完成，否则 handleToolCallDelta 无法调用 parsePartialToolArgs。

### S-T5 partial JSON 参数解析工具

**目标**：从可能未闭合的 JSON 字符串中容错提取指定 key 的字符串值，用于 write/edit/bash 实时进度展示。

- [x] **S-T5-1** 实现 extractPartialString
  - 文件：`src/renderer/features/chat/partialJsonArgs.ts`（新文件）
  - 从 partial JSON 中按 key 查找字符串值，支持完整闭合和截断两种情况
  - 支持 JSON 转义：`\" \\ \/ \n \r \t \b \f \uXXXX`
  - 找不到 key 返回 undefined，字符串未闭合返回已收部分
  - 验收：核心提取逻辑正确 ✅

- [x] **S-T5-2** 实现 parsePartialToolArgs 派发
  - 文件：`src/renderer/features/chat/partialJsonArgs.ts`
  - 按 toolName 选择需展示的字段：write(path+content)、edit(path+old+new)、bash(command)
  - 字段名已与 `writeTool.ts`、`editTool.ts`、`bashTool.ts` 的参数 schema 核对一致
  - 验收：各工具字段名与实际 schema 一致 ✅

- [x] **S-T5-3** 编写 S-T5 单元测试
  - 文件：`tests/unit/renderer/partialJsonArgs.test.ts`（新文件）
  - 覆盖：空字符串/缺失 key、完整 JSON、半截 path、半截 content、含 `\n` 转义、含转义引号截断、`\uXXXX` 完整与不完整、key 后空格、key 后无冒号、非字符串值、write/edit/bash 派发、1000 次累加大文件压测
  - 验收：22 个场景全部通过 ✅

---

### S-T4 Renderer 状态层：useAppStore 接入流式增量

**目标**：store 新增 `streamingToolArgs` 字段和相关 actions，处理 start/delta/final 全生命周期。
**⚠️ 依赖**：S-T4-3（handleToolCallDelta）依赖 S-T5（parsePartialToolArgs），必须先完成 S-T5 再做 S-T4-3。

- [x] **S-T4-1** 新增 store 字段和类型
  - 文件：`src/renderer/stores/useAppStore.ts`
  - AppState 新增 `streamingToolArgs: Record<string, string>`
  - ExtendedToolCall 新增 `argumentsRaw?: string`（仅 renderer 内存层，不导出到 shared）
  - 文件顶部新增本地类型 `RendererToolBlock = ToolBlock & { argumentsRaw?: string }`、`RendererMessageBlock`
  - ExtendedMessage.blocks 改为 `RendererMessageBlock[]`
  - 初始值 `streamingToolArgs: {}`
  - 验收：TypeScript 编译通过，shared 类型不受影响 ✅

- [x] **S-T4-2** 实现 handleToolCallStart
  - 文件：`src/renderer/stores/useAppStore.ts`
  - 收到 start 时在对应 message 的 blocks 里插入 running 状态的 ToolBlock，toolCalls 里插入 ExtendedToolCall，streamingToolArgs 置入空字符串
  - 验收：start 到达后 blocks 和 toolCalls 都有对应 running 条目 ✅

- [x] **S-T4-3** 实现 handleToolCallDelta ⚠️ 依赖 S-T5 已完成
  - 文件：`src/renderer/stores/useAppStore.ts`
  - 累积 `streamingToolArgs[toolCallId]`，调用 `parsePartialToolArgs` 解析当前进度，更新对应 ToolBlock 和 ExtendedToolCall 的 arguments 和 argumentsRaw
  - 验收：每次 delta 到达后 ToolBlock.arguments 反映当前已解析的字段 ✅

- [x] **S-T4-4** 修改 handleToolCall 合并 final args
  - 文件：`src/renderer/stores/useAppStore.ts`
  - 收到 final tool_call 时：如果 start 已插过 ToolBlock 则用解构剔除 argumentsRaw 并覆盖 args；如果没收到 start 则兜底插入
  - 从 `streamingToolArgs` 清除对应 key
  - 验收：final 到达后 streamingToolArgs 无残留，ToolBlock.argumentsRaw 为 undefined ✅

- [x] **S-T4-5** 修改 cancelExecution 兜底清理
  - 文件：`src/renderer/stores/useAppStore.ts`
  - 取消时把所有 status='running' 的 ToolBlock 和 ExtendedToolCall 标为 error + result='用户取消执行'，解构剔除 argumentsRaw
  - 清空整个 streamingToolArgs
  - 验收：取消后无残留 running 卡片，streamingToolArgs 为空 ✅

- [x] **S-T4-6** 编写 S-T4 单元测试
  - 文件：`tests/unit/renderer/streamingToolCallStore.test.ts`（新文件）
  - 断言 start → delta×N → final 后 streamingToolArgs 已清空、ToolBlock.arguments 是最终完整对象、argumentsRaw 为 undefined
  - 断言 delta 后 block.arguments 和 toolCalls.arguments 反映 partial 解析结果
  - 断言 cancel 后所有 running 卡片变 error、streamingToolArgs 清空
  - 验收：测试通过 ✅

---

## Phase S3：流式卡片 UI 组件 + 入口路由

> 构建视觉组件并接入 ChatPanel，使 write/edit 工具在流式期间呈现实时进度卡片。

### S-T6 流式写入卡片组件

**目标**：新增 StreamingFileCard 组件，复用 DiffViewer 视觉风格，等宽 body + 行号 + 自动滚动 + 状态指示器。

- [x] **S-T6-1** 抽取 syntaxHighlight 共享模块
  - 文件：`src/renderer/features/diff/syntaxHighlight.ts`（新文件）
  - 从 `DiffViewer.tsx` 提取 TokenType / KEYWORDS / detectLanguage / highlightLine
  - DiffViewer.tsx 改为 `import { highlightLine } from './syntaxHighlight'`
  - 运行 DiffViewer 相关单测确认不影响现有功能
  - 验收：DiffViewer 行为不变，StreamingFileCard 可复用高亮逻辑

- [x] **S-T6-2** 实现 StreamingFileCard 组件
  - 文件：`src/renderer/features/chat/StreamingFileCard.tsx`（新文件）
  - Props：toolCallId、toolName(write/edit)、status、args、argumentsRaw、result
  - 自动展开/收起策略：running 默认展开，完成后自动收起；用户手动操作不被覆盖
  - 自动滚动用 rAF 节流，避免每个 chunk 同步 layout
  - write 用 content 字段，edit 用 new 字段作为预览文本
  - 验收：组件渲染逻辑完整 ✅

- [x] **S-T6-3** 实现 StreamingFileCard CSS
  - 文件：`src/renderer/features/chat/StreamingFileCard.css`（新文件）
  - 复用 DiffViewer 视觉语言：圆角边框、header 行高字体、状态徽章颜色
  - 状态指示器：running = 蓝色旋转圆圈（0.8s 线性循环）、success = 绿色对勾、error = 红色叉
  - body 限制 max-height: 360px + overflow-y: auto，等宽字体 + 行号
  - 颜色变量对齐现有 App.css / ChatPanel.css
  - 验收：视觉风格与 DiffViewer 一致 ✅

- [x] **S-T6-4** 确认或新增 SpinnerIcon
  - 文件：`src/renderer/components/Icons.tsx`
  - 如果已有可旋转图标可复用则跳过；否则新增 SpinnerIcon
  - 验收：StreamingFileCard 的 running 状态有旋转动画图标 ✅

---

### S-T7 入口路由：App + ChatPanel 接入

**目标**：注册流式事件订阅，ChatPanel 把 write/edit 工具路由到 StreamingFileCard。

- [x] **S-T7-1** App.tsx 注册流式事件订阅
  - 文件：`src/renderer/App.tsx:38-126`
  - 在 useEffect 中订阅 `agent:tool-call-start` 和 `agent:tool-call-delta`
  - 调用 `handleToolCallStart` 和 `handleToolCallDelta`
  - cleanup 函数取消订阅，依赖数组加入新 actions
  - 验收：renderer 可接收并处理流式事件 ✅

- [x] **S-T7-2** ChatPanel 路由 write/edit 到 StreamingFileCard
  - 文件：`src/renderer/features/chat/ChatPanel.tsx`
  - 在 ToolBlock 渲染分支中：write/edit 走 StreamingFileCard，其余走 ToolBox
  - ChatPanel 顶部声明 `type ToolBlockWithRaw = ToolBlock & { argumentsRaw?: string }` 用于取 argumentsRaw
  - 验收：write/edit 显示流式卡片，bash/read/grep 等仍走 ToolBox ✅

---

## Phase S4：端到端验证

> 类型检查 + 单元测试 + 手动端到端验证 + 回归校验。

### S-T8 验证

**目标**：全链路功能正确，无回归。

- [x] **S-T8-1** 类型检查通过
  - 运行 `npm run typecheck`
  - 验收：无类型错误 ✅

- [x] **S-T8-2** 全量单测通过
  - 运行 `npx vitest run`
  - 现有测试 + 新增测试全部通过
  - 验收：0 failed ✅

- [ ] **S-T8-3** 手动端到端验证 — 长 HTML 写入
  - 在 default mode 让模型写 1000+ 行 HTML
  - 验收：模型说完文字后 StreamingFileCard 立刻出现，header 显示文件名 +「新建」+ 蓝色旋转圆圈
  - 验收：body 等宽字体逐行刷出代码，自动滚动，行号正确，右上角行数实时增长
  - 验收：写入完成后 body 自动收起，圆圈变绿色对勾
  - 验收：消息结束后 DiffViewer 卡片仍正常出现在消息末尾

- [ ] **S-T8-4** 手动端到端验证 — edit 修改
  - 让模型对已有文件做 edit
  - 验收：流式卡片状态徽章为「修改」，body 显示 new 字段内容

- [ ] **S-T8-5** 手动端到端验证 — 手动展开/收起保护
  - running 阶段用户点击收起 → 之后 status 变化时保持收起
  - 完成后用户点击展开 → 之后不被自动覆盖
  - 验收：用户手动操作优先级高于自动策略

- [ ] **S-T8-6** 手动端到端验证 — 取消执行
  - 长 HTML 写入过程中点取消
  - 验收：流式卡片状态变 error，圆圈变红色叉，result 显示「已取消」，body 自动收起
  - 验收：刷新或重启后，取消的半成品 ToolBlock 不出现在历史里

- [ ] **S-T8-7** 手动端到端验证 — plan mode
  - plan mode 下让模型尝试 write
  - 验收：UI 不显示 StreamingFileCard，模型仍能正常推理

- [ ] **S-T8-8** 手动端到端验证 — bash 工具 + 多 write 并发
  - bash 仍走原 ToolBox，不出现 StreamingFileCard
  - 多个 write 并发时每张卡片独立刷新，不串
  - 验收：bash 正常、多卡片独立

- [ ] **S-T8-9** 性能与回归校验
  - 1000+ 行写入过程中思考/文本阶段不卡顿
  - DiffViewer 仍按 live skeleton → final 路径（不出现 +0 -0）
  - 取消后不残留权限拒绝条目
  - 流式卡片滚动用 rAF 节流，不出现高频 smooth 排队问题
  - 验收：无回归问题

---

## 执行检查点（Streaming Tool Call）

| 检查点 | 完成条件 | 验证方式 |
|---|---|---|
| SCP1 — S-T1+T2+T3 完成 | SSE → renderer 增量事件通路打通 | mock SSE 测试 + IPC 事件到达 renderer |
| SCP2 — S-T4+T5 完成 | store 正确维护流式状态，partial JSON 解析正确 | 单元测试通过 |
| SCP3 — S-T6+T7 完成 | write/edit 工具在 UI 上显示流式卡片 | typecheck + build + 单元测试通过，手动验证待执行 |
| SCP4 — S-T8 部分完成 | 全链路功能正确，无回归 | typecheck ✅ + 单测 ✅（360 passed）+ build ✅，端到端手动验证待执行 |

---

## 执行顺序与提交规范

1. 先做 S-T6-1（syntaxHighlight 抽取，StreamingFileCard 的依赖）
2. 然后 S-T1 → S-T2 → S-T3 → **S-T5 → S-T4**（S-T5 必须先于 S-T4-3，因为 handleToolCallDelta 依赖 parsePartialToolArgs） → S-T6-2/3/4 → S-T7 → S-T8
3. 每提交一次都跑 `npm run typecheck`，S-T5/S-T8 跑 `npx vitest run`

提交格式（中文 Conventional Commits）：
```
refactor(diff): 抽取 syntaxHighlight 工具模块（S-T6 前置）
feat(stream): S-T1 模型层 SSE 工具调用增量同步 yield
feat(stream): S-T2 AgentLoop 透传流式工具调用事件
feat(stream): S-T3 IPC channel 注册并向 renderer 转发流式事件
feat(stream): S-T5 partial JSON 参数解析工具与单测
feat(stream): S-T4 useAppStore 接入流式工具调用增量
feat(stream): S-T6 新增 StreamingFileCard 流式写入卡片组件
feat(stream): S-T7 ChatPanel 把 write/edit 路由到 StreamingFileCard
test(stream): S-T8 端到端流式工具调用回归校验
```

完成后更新 `CHANGELOG.md`。

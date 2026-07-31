# Nova Harness Token Efficiency Audit

> 审计目标：追踪 Nova Agent 当前 `dev` 工作区每次模型调用前输入 token 的完整装配过程，识别冗余、可裁剪或可重构的 token 支出，形成可执行的 P0/P1/P2 优化方案与 A/B 评测计划。
>
> 审计方法：以当前工作树为唯一事实来源；使用 `tiktoken 0.12.0`（`o200k_base`、`cl100k_base`）做跨提供商标注 token 估算；通过临时 tsx 脚本直接复用项目内 prompt 构建与工具注册模块，确保测量值来自真实源码而非手工复制。

## 1. 摘要

当前实现下，一条首次模型请求的输入 token 大致为：

- **default 模式 + native 方言（gpt-4o 近似）：约 10.5k tokens**（`o200k_base`），其中 API `tools` JSON 占 6.3k，系统提示 3.8k。
- **plan 模式 + native 方言：约 8.8k tokens**，工具数从 15 降至 10，带来约 1.6k tokens 节约。
- **XML 方言：约 7.8k（default）/ 6.9k（plan）tokens**，但大段工具说明被全部注入 system prompt，理论上仍可缓存；native 与 XML 的差异主要体现为“在 system prompt 中付费” vs “在每次请求体 `tools` 字段付费”。

最大 token 黑洞是工具描述与项目规则。单条 `todo_write` 的工具描述长达 2132 字符、占用约 1379 tokens；`askQuestion`（969 tokens）、`bash`（668 tokens）、`web_search`（452 tokens）次之。`AGENTS.md` 项目规则在 system prompt 中固定注入约 1.5k tokens（`o200k_base`）。

缓存稳定性方面：
- 系统提示前缀由 `buildStableSystemPrompt` 构造，`modeInstruction` 拼接到 **用户消息尾部**，session context 仅注入 **第一条用户消息**，符合 prefix-only append 原则。
- L1 memory 仅在 `memoryEnabled` 时注入，`memoryContext` 层上限 3200 字符；L2 检索记忆不走 system prompt。
- `todo_write` 结果不入持久会话消息，仅作为 `tool` 消息进入当轮上下文，且输出格式为 JSON，需警惕大列表回灌。
- Anthropic 客户端走 `cache_control` 时，对 system + 最近 2 条非 system 消息 + 最后 1 个 tool 定义打标；`XML` 方言不发送 `tools` 字段，因此工具定义无法享受 Anthropic 工具前缀缓存。

## 2. 审计边界

- 分支：`dev`；工作区有大量变更（`git status` 显示约 141 个 tracked file changes，含大量旧 Compose/XForge 实现删除）。本审计**只以当前工作树为准**，不追溯 HEAD 历史。
- 被审计模块集中在 `src/runtime/agent/promptBuilder`、`src/runtime/tools`、`src/runtime/model`、`src/runtime/agent/compaction`、`src/runtime/memory`、`src/runtime/sessions`。
- 未实际发送真实 API 请求；token 数为 tiktoken 估算，不等于各 provider 计费器。但相对排序与比例可信。

## 3. 请求装配链路

### 3.1 System Prompt 七层

`SystemPromptBuilder.build`（`src/runtime/agent/promptBuilder/SystemPromptBuilder.ts`）按以下顺序拼接：

1. `agentRole`：`buildStableSystemPrompt` 产物（当前工作目录、日期、模型等元信息包装）。
2. `baseRules`：`src/runtime/agent/prompts/base-rules.md` 中的“行为契约”。
3. `projectRules`：`discoverProjectRules` 从 `AGENTS.md` / `CLAUDE.md` / `.cursorrules` 向上遍历发现。
4. `memoryContext`：L1 项目记忆，上限 3200 字符（`MemoryBudget.ts` 中 `DEFAULT_L1_MAX_CHARS`）。
5. `skillContext`：`buildSkillContextForMode` 按当前 mode 与 skill 可见性拼接。
6. `modeInstruction`：仅 `compose` 模式非空，为 workflow 路由上下文；`default` / `plan` 为空。
7. `toolSummary`：`renderModeToolInventory` 生成的工具清单，native 短、XML 长。

上述产物写入 `messages[0]`，后续不再变动（frozen system prompt）。

### 3.2 用户消息

`AgentLoop.runTurn` 在每轮用户消息中追加：
- 当前 `modeInstruction`（`getModeInstruction`），例如 `[当前模式: plan]`。
- session context 仅在 **第一条用户消息** 注入，后续消息不再重复；
- compose 模式下，system prompt 额外包含 `renderRouterContext` 产物。

### 3.3 工具过滤与 API body

`AgentContext.getEffectiveToolDefinitions` 调用 `getModeVisibleTools(mode, definitions)`，过滤当前 mode 可见工具。`runAgentLoop` 中：

```ts
const nativeTools = context.dialect === 'xml' ? undefined : tools
```

因此：
- **native 方言**：请求体包含完整 `tools` JSON（每条含 `name/description/parameters`）。
- **xml 方言**：请求体 **不发送 `tools` 字段**，模型输出通过 `XmlToolScanner` 从 content 中扫描 `<invoke>`。

`OpenAICompatibleModelClient.toApiMessage` 把 `ChatMessage` 转成 API body；`applyCacheMarkers` 按 `CacheProfile.marker` 对 system + 最近 2 条非 system 消息加 `cache_control`；`applyToolCacheMarker` 对最后一个 tool 定义加 `cache_control`。

## 4. Token 分段测量

### 4.1 静态组件（`o200k_base` / `cl100k_base`）

| 组件 | `o200k_base` | `cl100k_base` | 字符 |
|------|-------------:|--------------:|-----:|
| stablePrompt | 198 | 265 | 352 |
| baseRules | 619 | 771 | 1,002 |
| projectRules | 1,517 | 2,066 | 2,699 |
| sessionContext | 45 | 46 | 154 |
| memoryL1 (max) | 400 | 400 | 3,200 |

说明：
- `projectRules` 来自仓库根 `AGENTS.md`，约 2.7k 字符，是 system prompt 中第三大固定支出。
- `baseRules` 是 `base-rules.md` 全量注入，约 1k 字符，包含工具优先级、探索策略、完成契约、模式/写边界等。
- `sessionContext` 仅注入一次，开销很小但附加在每轮首条 user message 中。
- L1 memory 上限固定为 3200 字符；当前无 `MEMORY.md`，若启用则需关注其预算。

### 4.2 按模式/方言的完整请求体

以 `o200k_base` 估算：

| Mode/Dialect | System Prompt | User Text | Tool Summary | Mode Instruction | API Tools JSON | Request Body | 可见工具数 |
|--------------|--------------:|----------:|-------------:|-----------------:|---------------:|-------------:|-----------:|
| default_native | 3,803 | 188 | 813 | 135 | 6,277 | **10,547** | 15 |
| default_xml | 6,936 | 205 | 3,946 | 152 | 0 | **7,755** | 15 |
| plan_native | 3,568 | 261 | 578 | 208 | 4,688 | **8,793** | 10 |
| plan_xml | 6,067 | 279 | 3,077 | 226 | 0 | **6,890** | 10 |
| compose_native | 4,142 | 190 | 797 | 137 | 6,334 | **10,953** | 15 |
| compose_xml | 7,279 | 207 | 3,934 | 154 | 0 | **8,109** | 15 |

以 `cl100k_base` 估算：

| Mode/Dialect | System Prompt | User Text | Tool Summary | Mode Instruction | API Tools JSON | Request Body |
|--------------|--------------:|----------:|-------------:|-----------------:|---------------:|-------------:|
| default_native | 4,781 | 251 | 981 | 195 | 7,254 | **12,561** |
| default_xml | 8,587 | 272 | 4,787 | 216 | 0 | **9,465** |
| plan_native | 4,502 | 377 | 702 | 321 | 5,469 | **10,621** |
| plan_xml | 7,570 | 403 | 3,770 | 347 | 0 | **8,510** |
| compose_native | 5,207 | 240 | 949 | 184 | 7,304 | **13,035** |
| compose_xml | 9,017 | 261 | 4,759 | 205 | 0 | **9,894** |

关键洞察：
1. **API `tools` JSON 是 native 方言下的绝对大头**：default 模式请求中，工具 JSON 约占请求 token 的 60%。
2. **XML 把工具 JSON 成本移到 system prompt 缓存区**：请求体少了 `tools` 字段，总 token 下降约 2.8k；但工具描述必须全部进入 system prompt，若 system prompt 未命中缓存（例如新会话），首次成本更高。
3. **plan 模式 token 低的核心原因是工具数少**，而非 tool 描述变短；单个 tool 的平均 token 成本不变。
4. **compose 模式 system prompt 增加约 340 tokens** 来自 workflow 路由上下文，但请求体与 default 基本持平。

### 4.3 单个工具 JSON 的 Token 占用

对 native 请求体中每条 tool 定义（`type` + `function.name/description/parameters`）用 `o200k_base` 估算：

| Tool | desc chars | params chars | total tokens | desc tokens |
|------|-----------:|-------------:|-------------:|------------:|
| todo_write | 2,132 | 478 | **1,379** | 1,116 |
| askQuestion | 1,210 | 852 | **969** | 604 |
| bash | 918 | 384 | **668** | 476 |
| web_search | 613 | 406 | **452** | 274 |
| grep | 44 | 890 | 385 | 33 |
| edit | 84 | 647 | 343 | 52 |
| memory_search | 228 | 156 | 238 | 150 |
| start_workflow | 32 | 426 | 200 | 18 |
| read | 92 | 318 | 191 | 48 |
| save_plan | 105 | 245 | 176 | 59 |
| switch_mode | 99 | 233 | 152 | 47 |
| find | 33 | 250 | 131 | 20 |
| write | 64 | 194 | 131 | 38 |
| invoke_skill | 38 | 191 | 114 | 25 |
| task | 34 | 203 | 109 | 23 |
| ls | 32 | 131 | 95 | 23 |

前四名工具合计占 API `tools` JSON 约 **3.5k tokens**，超过 default 模式工具总 token 的 55%。其中 `todo_write` 是 plan 与 default 都可见的“通用重载工具”。

## 5. Native / XML 协议、Provider 序列化与缓存

### 5.1 方言判定

`src/runtime/model/dialect.ts` 的 `preferredToolDialect`：
- 默认 native；
- 显式 override 或 modelId 命中 `ollama` 家族时 fallback 到 XML；
- 兼容 OpenAI / DeepSeek / Kimi / GLM / Qwen / MiniMax 等官方端点均走 native。

`src/runtime/agent/core/runAgentLoop.ts` 决定请求体是否带 `tools`：

```ts
const nativeTools = context.dialect === 'xml' ? undefined : tools
```

### 5.2 缓存标记

`src/runtime/model/cacheProfile.ts` 定义 7 个 profile（anthropic / deepseek / kimi / glm / minimax / openai / generic）。仅 `anthropic` 档案启用 `cache_control`。

`src/runtime/model/messageFormat.ts`：
- `applyCacheMarkers`：对 **system** + 最后 **2 条非 system 消息** 加 `cache_control`；跳过 `internal` / `skipCacheMarker` 消息。
- `applyToolCacheMarker`：对 **最后一个 tool 定义** 加 `cache_control`。

这意味着：
- Anthropic 下，system prompt（含 XML 长工具说明）可被缓存；但如果走 XML 方言，请求体没有 `tools` 字段，也就没有工具级缓存点。
- native 方言时，system prompt 较短（无完整工具说明），但 `tools` 字段末尾被打标，整体工具前缀可受益于 Anthropic 工具缓存。
- 滚动双缓冲策略使最近 2 条消息逐轮交替命中；用户消息中的 `modeInstruction` 与 session context 会随最近 2 条消息参与缓存，但只拼接到用户消息中，不污染 system prefix。

### 5.3 Fallback 与方言切换

`ModelClientPool` 管理主模型 + 多个 fallback。`StreamProcessor` 在 fallback 时调用 `syncToolDialect`，但 **system prompt 中的 `toolSummary` 在 `AgentRuntimeFactory` 已冻结**。若主模型与 fallback 模型方言不同（native ↔ XML），将出现“system prompt 工具说明格式”与“实际请求是否发 `tools`”不一致的潜在风险。

## 6. 上下文压缩、会话恢复与 Todo

### 6.1 上下文预算

`ContextBudgetManager`（`src/runtime/agent/ContextBudgetManager.ts`）生产环境由 `createProductionContextBudgetManager(contextWindow)` 创建：
- 预留输出 token = `min(8192, floor(contextWindow * 0.15))`。
- 硬上限 token = `contextWindow - reserved`。
- 硬上限字节 = 硬上限 token × 4。

`enforceInline` 用 `JSON.stringify(messages)` 字节 / 4 粗估 token，决定是否需要压缩。该估算对中文偏低（UTF-8 3 字节/字 ÷ 4 ≈ 0.75 字/token，实际中文约 1.5 字/token），可能导致压缩触发延迟，是一个**低估风险点**。

### 6.2 压缩策略

`applyContextBudget` 分四阶段：
1. `ageToolResults`：老工具结果替换为 `[aged tool result]` 占位；
2. `artifact_ref`：>16KB 且带 `artifactId` 的工具结果替换为 artifact 指针；
3. `superseded_removed`：对 `read/edit/write/ls` 同路径旧结果做去重占位；
4. 硬预算仍超时，找保护区外最大工具结果做 `budget_hard_trim`。

`compaction` 阶段额外做内容哈希去重（`content_hash_dedup`）。

### 6.3 会话恢复

`src/runtime/sessions/contextSnapshot.ts` 的 `restoreOrInjectHistory`：
- 若存在压缩快照且锚点消息仍活跃，合并 `snapshot.recentMessages` 与增量对话；
- 否则调用 `buildConversationContext` 从 `SessionData` 重建完整 `ChatMessage[]`。

`buildConversationContext`（`src/runtime/agent/context/contextBuilder.ts`）：
- 无 reasoningReplay 时扁平恢复：1 条 assistant + 多条 tool；
- 有 reasoningReplay 时按 blocks 拆分“子轮”。
- 不会重新注入 system prompt（由 AgentLoop 构建时注入）。

### 6.4 Todo 注入

`todoWriteTool`（`src/runtime/tools/todoWriteTool.ts`）是 `readonly` 且所有 mode 可见。每次调用全量替换 `SessionData.todos`，工具返回值为完整 todo 列表 JSON。由于 todo 不进入持久会话上下文（只通过事件 UI 更新），它**不直接参与 system prompt / prefix 缓存**。但当模型在最近轮次调用 `todo_write` 后，tool 消息会进入下一轮上下文，若列表很长会线性膨胀。

## 7. 重复约束与缓存稳定性分析

### 7.1 重复约束

1. **baseRules** 与 **projectRules** 均包含“行为/边界/完成契约”语义：
   - `base-rules.md` 讲“工具优先级、探索策略、完成契约、自我检查、模式/写边界”；
   - `AGENTS.md`（仓库工程规则）进一步讲“单一职责、最小完整、禁止补丁、测试验证、注释只解释 why”。
   - 两者在“不要绕过校验、不要硬编码、测试优先”等语义上存在重叠，但属于不同层级（通用行为 vs 项目工程）。

2. **modeInstruction 与用户消息追加**：
   - compose 的 system prompt 层有 `renderRouterContext`；
   - 每轮用户消息又有 `getModeInstruction('compose')`。
   - 当前 compose 的 `modeInstruction` 层实际为 router context，但变量命名易引起混淆。

3. **todo_write 描述中“何时应该/不应该”与 system prompt 行为契约**：
   - `TODO_WRITE_DESCRIPTION` 花了 2k+ 字符重复“简单任务不要建 todo”；
   - `baseRules` 已经要求“用户请求直接时直接做，不要过度拆分”。

### 7.2 缓存稳定性

- `buildStableSystemPrompt` 产物不依赖当前轮次用户输入；`modeInstruction` 与 session context 只追加到 **user** 消息，符合 `messages[0]` 字节不变的 prefix-cache 契约。
- `AgentLoop` 的 `frozenSystemPrompt` 固定为 `messages[0]`；压缩摘要替换历史但不重写 `messages[0]`。
- `getModeInstruction` 返回字符串依赖 `mode` / `dialect`；同一个 session 内稳定。
- 风险点：fallback 切换方言后，`toolSummary` 仍以原始 dialect 冻结，若主/fallback 方言不同，可能造成缓存命中但解析失败。

## 8. 风险与退化评估

| 风险 | 说明 | 影响 |
|------|------|------|
| 低估上下文预算 | `estimateContextSize` 用 UTF-8 字节 /4 估算中文，实际中文 token 可能翻倍 | 压缩触发偏晚，context 超限概率上升 |
| XML 长 system prompt 未命中缓存 | 首条请求或缓存失效后，XML 要把 4k tool 说明全送入 system prompt | 首次请求成本高于 native |
| Fallback 方言漂移 | system prompt 已冻结，fallback 切换 native/XML 后 tool 说明格式不一致 | 工具调用失败或格式错配 |
| `todo_write` 输出回流 | 每次调用返回完整 todo JSON，大列表会作为 tool 消息进入后续上下文 | 会话后期 context 额外增长 |
| AGENTS.md 与 baseRules 膨胀 | 固定前缀 2.1k+ tokens，每轮都带；若 AGENTS.md 继续扩大则无法避免 | 单次请求基础开销高 |

## 9. P0 / P1 / P2 优化建议

### P0（高影响、低/中风险、可快速验证）

1. **压缩 `todo_write` 描述**  
   当前 2132 字符 / 1379 tokens，占 default 工具 JSON 的 22%。建议将“示例与状态机”剥离到 system prompt 的 skill/memory 或 `baseRules` 中，只保留 tool 描述中的“用途 + 触发条件摘要”。目标：降至 500 tokens 以内，节约约 800 tokens/请求。  
   涉及：`src/runtime/tools/todoWriteDescription.ts`。

2. **缩短 `askQuestion` 描述**  
   当前 1210 字符 / 969 tokens。将多示例、长护栏迁移到 `base-rules.md` 的“交互规范”中，tool 描述保留核心用途与参数说明。目标：降至 300 tokens 以内。  
   涉及：`src/runtime/tools/askQuestionTool.ts` 或拆分出的描述文件。

3. **对 native 方言精简 `bash` 动态描述**  
   `bash` 描述 918 字符，其中大量平台/壳配置说明。建议将“壳路径/最大行数”等可配置信息沉淀到 `baseRules`，tool 描述保留摘要。  
   涉及：`src/runtime/tools/bash/index.ts`（`get description()`）。

4. **修正 token 估算：中文采用更保守的估算或按字符加权**  
   `estimateContextSize` 与 `tokenEstimator.estimateTokens` 均基于 4 字符/4 字节假设，对中文低估。建议至少将中文字符单独处理：中文按 ~1.5 字/token 或字节/3 估算；或引入 tiktoken/公开 tokenizer 离线估算。  
   涉及：`src/runtime/agent/ContextBudgetManager.ts`、`src/runtime/agent/tokenEstimator.ts`。

### P1（中影响，需架构评估）

5. **项目规则分层加载**  
   当前 `discoverProjectRules` 无条件将 `AGENTS.md` 全文（2.7k 字符）注入每轮 system prompt。可拆分为：
   - 常量/原则层（必须保留）；
   - 编程规范层（仅在 write/edit/bash 相关任务时动态注入）；
   - 目录/约定层（仅在前 1-2 轮注入）。
   涉及：`src/runtime/agent/context/projectRulesDiscovery.ts`、`SystemPromptBuilder` 层参数。

6. **XML 工具说明按需缓存**  
   XML 方言下，完整工具说明进入 system prompt，但仅在 `cache_control=anthropic` 时可缓存。非 Anthropic XML 场景（如 Ollama）应支持更短工具说明或 `cache_control` 打标；或放弃 XML 长说明，改用“简短 native tool definition + 本地 XML 解析提示”混合方案。  
   涉及：`src/runtime/model/messageFormat.ts`、`toolPromptRenderer.ts`。

7. **工具描述与示例集中化**  
   将重工具（todo_write / askQuestion / web_search）的“模型使用示例”统一迁移到 system prompt 的行为契约或 skill context 中，tool description 只保留签名级说明。这样可以被前缀缓存覆盖，而不是每条请求重复支付。  
   涉及：`base-rules.md`、`buildSkillContext`、各 tool 描述文件。

### P2（低影响、长期）

8. **会话级 `todo_write` 输出折叠**  
   当 todo 列表 > 5 项时，tool 返回改为 `summary` + `delta`（前一次差异），由模型自行维护完整列表；或持久化后只返回 `OK`。  
   涉及：`src/runtime/tools/todoWriteTool.ts`。

9. **模式特定 tool 描述**  
   对 `plan` 等只读模式，隐藏 write/edit/bash 等写工具后，可进一步简化 read/ls/find/grep 描述，只暴露与“规划”相关的语义。  
   涉及：`getModeVisibleTools` 与 tool 参数/描述的按模式覆写。

10. **fallback 方言回退一致性**  
    在 `AgentLoop` 中 fallback 切换后，若方言改变，应重新构建 `toolSummary` 或至少发事件提醒用户“工具调用格式可能不一致”。  
    涉及：`src/runtime/agent/AgentLoop.ts`、`StreamProcessor`。

## 10. 两层 A/B 评测方案

### A/B 1：工具描述瘦身（P0 #1/#2/#3）

**目标**：验证压缩 `todo_write / askQuestion / bash` 描述后，token 显著下降且工具调用正确率不降低。

- **对照组 A（当前）**：完整 tool description。
- **实验组 B**：精简 description，将示例/状态机/平台细节迁移到 system prompt。
- **指标**：
  - 每轮首次请求 token 数（default / plan / compose）。
  - `todo_write` 调用次数 / 误触发率（无意义单步任务仍建 todo 的比例）。
  - `askQuestion` 被调用的必要性与信息完整性。
  - `bash` 参数正确率（模型是否仍遵守 maxLines / maxBytes 限制）。
- **方法**：
  - 构造 30 条典型中文指令（简单/多步/规划/信息查询），分别用 A/B 两组 prompt 发送给同一模型 3 次，统计 token 与调用行为。
  - 可由 `extract.ts` 直接产出 A/B 两组 `prompt-strings.json`，再用 `measure.py` 比较。

### A/B 2：native vs XML 方言在真实 provider 下的成本与稳定性

**目标**：确认 XML 方言虽请求 token 更低，但工具调用成功率、首 token 延迟是否可接受。

- **对照组 A（native）**：请求体带完整 `tools` JSON。
- **实验组 B（xml）**：请求体不带 `tools`，工具说明全量进 system prompt。
- **指标**：
  - 首次请求 token、缓存命中率（Anthropic `cache_read_input_tokens`）。
  - 工具调用解析成功率（`<invoke>` 格式 / 参数转 JSON 失败率）。
  - 首 token 时间（TTFT）。
  - fallback 切换后是否出现格式错配。
- **方法**：
  - 对 DeepSeek / Kimi / GLM / MiniMax / Anthropic 各跑 20 轮包含 3-4 个工具的对话。
  - 监控 `OpenAICompatibleModelClient` 的 `wire_snapshot` 与 `usage` 事件。

## 11. 测量方法附录

1. 在 `C:\Users\xuhaochen\AppData\Local\Temp\nova-harness-audit` 下创建 `extract.ts`。
2. 使用 `npx tsx@4.23.1` 直接加载项目源码，构建 `ToolRegistry`、`SkillRegistry`，并调用真实的 `SystemPromptBuilder.build` / `renderModeToolInventory` / `buildL1MemoryContext` / `discoverProjectRules`。
3. 输出 `prompt-strings.json`（含各 mode/dialect 的 system prompt、user text、apiTools、request body）。
4. 用 `py -3 measure.py` 加载 `tiktoken`，分别用 `o200k_base` 和 `cl100k_base` 统计各字符串 token。
5. 用 `measure2.py` 统计单条 tool JSON 的 token 占用。

## 12. 引用

- `src/runtime/agent/promptBuilder/SystemPromptBuilder.ts` —— 7 层 system prompt 拼接。
- `src/runtime/agent/AgentLoop.ts` —— frozen system prompt 与用户消息追加。
- `src/runtime/agent/promptBuilder/modePrompt.ts` —— `buildStableSystemPrompt`。
- `src/runtime/agent/promptBuilder/modeInstruction.ts` —— `getModeInstruction`。
- `src/runtime/agent/promptBuilder/toolPromptRenderer.ts` —— `renderModeToolInventory`。
- `src/runtime/agent/core/runAgentLoop.ts` —— `nativeTools = context.dialect === 'xml' ? undefined : tools`。
- `src/runtime/model/OpenAICompatibleModelClient.ts` —— API body 序列化、cache 标记、reasoning 回放。
- `src/runtime/model/cacheProfile.ts` —— provider 缓存能力判定。
- `src/runtime/model/messageFormat.ts` —— `applyCacheMarkers`、`applyToolCacheMarker`、`sanitizeToolMessages`。
- `src/runtime/model/dialect.ts` —— `preferredToolDialect`。
- `src/runtime/agent/ContextBudgetManager.ts` —— 上下文预算、压缩策略、token 估算。
- `src/runtime/agent/compaction/CompactionService.ts` —— 上下文压缩生命周期。
- `src/runtime/memory/MemoryBudget.ts` —— L1/L2 记忆预算。
- `src/runtime/tools/todoWriteDescription.ts` —— `todo_write` 长描述。
- `src/runtime/sessions/contextSnapshot.ts` —— 压缩快照与会话恢复。

---

*审计报告生成时间：2026-07-31。Token 数据来自 tiktoken 0.12.0 对当前工作树的离线估算，实际计费以 provider 为准。*

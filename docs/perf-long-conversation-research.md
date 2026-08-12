# 长对话渲染性能：竞品调研与改进路线

本文是 `perf/electron-long-conversation` 分支的工作依据。目标：在长会话（单会话累积大量消息/工具调用）下持续降低卡顿与掉帧。

调研对象为与 Nova 同为 Electron + React 的主流 coding agent。原则：**只借鉴优于 Nova 的方案**，明确标注劣于 Nova 的部分以免回退。

---

## 一、Nova 现有能力清单（避免重复优化）

下列能力 Nova 已具备，任何改进方案都不应重复实现或回退：

1. DOM 虚拟化：`@tanstack/react-virtual`，overscan 6，`measureElement` 动态测高。`VirtualMessageList.tsx`
2. 状态层窗口化：内存最多 240 条，更早的分页按需 IPC 加载。`messageWindow.ts`、`constants.ts`、`paginationSlice.ts`
3. 尾部活跃 / 历史静态分层：最后 6 条「live」，其余「static」（关闭打字机、thinking 计时器、入场动画）。`messageRenderTier.ts`
4. 每条消息 `React.memo` + 基于 `_revision` 计数器的自定义 `areEqual`，只有被改动的消息会重渲染。`MessageItem.tsx`
5. 增量 markdown：已封存的 prefix 解析一次并冻结成 memoized chunk，只有小的 active tail 每帧重解析，避免 O(L²)。`incrementalMarkdown.ts`、`MarkdownRenderer.tsx`
6. 自研轻量逐行正则语法高亮（非 shiki / highlight.js / prism）。`syntaxHighlight.ts`
7. 两级 delta 合并：主进程 16ms + 渲染端 16ms/300ms buffer，每帧一次 `set`。`mainDeltaCoalescer.ts`、`streamDeltaBuffer.ts`、`streamSlice.ts:applyStreamDeltas`
8. 流式写入对 tail block 内容**原地 mutate**（in-place cast），避免高频短生命周期对象造成的 GC 抖动。
9. rAF 渲染池打字机：32ms 帧（≈31fps），自适应追赶速率，标签页切回时一次性补全。
10. 自动滚动用 `container.scrollTo`（非 `scrollIntoView`，避免对整棵消息树强制 layout）；rAF 合并 + 500ms 轮询；160ms 编程滚动守卫。`autoScroll.ts`
11. 已移除消息列表上的 framer-motion layout 动画（曾触发 `getBoundingClientRect` 全树同步回流）。
12. 会话级事件门控：非聚焦会话的 delta 不进 store。`agentEventGate.ts`
13. CSS `contain: paint`（侧栏）、`overflow-anchor: none` + 手动锚点修正（prepend 时不跳）。
14. 高亮 LRU 缓存（2000 条）。`highlightCache.ts`
15. 仅开发态 `React.Profiler` 仪表 + 性能预算（commit p95 50ms、rAF p95 25ms）。`streamingPerf.ts`
16. App 根只订阅稳定的 action 引用，不订阅 `messages` / `streaming`。

### 已知缺口（改进的主要着力点）

- **未用 React 18/19 并发能力**（`useDeferredValue`、`startTransition`、`useTransition`）。
- **未用 zustand 中间件**（`subscribeWithSelector`、`shallow`、transient subscription）。
- **`ChatPanel` 在流式期间每秒提交约 60 次**：它持有整个 `messages` 数组引用（`ChatPanel.tsx:99`），而流式 tail 就 mutate 在这个数组里——这是目前最突出的热点。

---

## 二、竞品结论概览

| 对标对象 | 栈 | 综合定位 |
|---|---|---|
| **Maka**（maka-agent/maka-agent） | Electron + React 19 + zustand + `@astryxdesign/core` | 在**流式订阅隔离**与**会话几何缓存**上优于 Nova；其余与 Nova 持平或落后（无 delta 合并、无状态层窗口） |
| **Open Cowork**（OpenCoworkAI/open-cowork） | Electron + React 18 + zustand v5 | 几乎全面落后于 Nova（无虚拟化、无增量 markdown、全量 highlight.js、`scrollIntoView`）；仅 `useShallow` 订阅卫生与 markdown 懒加载两点可借鉴 |
| **Cline**（cline/cline） | VS Code webview + React Context + react-virtuoso | 流式重渲染模型落后于 Nova（`deepEqual` memo + 向每行传 `lastModifiedMessage`，每帧全行重渲染；全量 state 推送有已记录的长上下文白屏缺陷 #10795）。但**列表/滚动工程**与**工具调用聚合**强于 Nova |
| **Roo Code**（RooCodeInc/Roo-Code） | 同 Cline 体系 | 滚动状态机、长输出折叠、异步 Shiki+纯文本先渲染等**局部**强于 Nova；markdown 全量重解析落后 |

**收敛结论**：四个独立调研均指向同一根因与同一最高杠杆修复——**把流式中的文本从 `messages` 数组里剥离到一个独立的「活跃回合」状态，只让尾部那条订阅它**。

---

## 三、最高杠杆修复（根因）

### （根因·1）流式热路径从 `messages` 数组剥离（「活跃回合」隔离）

**问题**：Nova 流式时在 `messages` 数组里原地 mutate tail block，每个 batch 产生新的数组引用，导致 `ChatPanel` 与所有订阅 `messages` 的组件每秒提交约 60 次。

**对标做法**（Maka、Open Cowork 一致）：
- 流式中文本存于独立状态（Maka 的 `liveTurnBySession` map；Open Cowork 的 `partialMessage` / `partialThinking` 字符串），**绝不写入 `messages` 数组**。
- `messages` 只在「完整消息到达」时才更新，流式全程引用稳定 → 已完成消息的 `React.memo` 永不失效。
- 流式内容通过 `liveStreaming` prop 注入到 tail 节点；live → settled 是**同一渲染路径**的数据源切换，不 unmount/mount。

**收益**：根因修复 ChatPanel 60Hz/秒提交；shell / 侧栏 / 输入框订阅 `messages` 但不订阅活跃回合，于是**流式期间完全不重渲染**。

**适用性**：高。**风险**：中偏高——要把 Nova 的流式 buffer 从消息 store 拆出成独立「活跃回合」slice，且要和现有增量 markdown（依赖 tail mutate）协调；live/settled 单渲染路径是最难回填的部分。

### （根因·2）`subscribeWithSelector` + 精确选择器 / transient 订阅

**问题**：Nova 所有订阅都是 hook 选择器，无中间件。

**做法**：
- 全局包一次 `subscribeWithSelector`；组件选择最小基元（如 `messages.length`），避免返回新对象（或对扁平小切片配 `shallow`）。
- 对**最高频**的尾部更新用 zustand 的 transient 订阅模式：`store.subscribe(selector, cb, { equalityFn })` 在 React 之外直接写 ref / 命令式更新 DOM，React 完全不参与提交。每条 Row 只订阅自己的 `_revision` 计数器。

**收益**：把尾部 token 流量移出 React 提交路径，顶层层提交从「每 batch 一次」降到「每条新消息一次」。

**适用性**：高。**风险**：低–中。命令式 DOM 更新是利器，限制在流式文本 tail 或纯副作用（滚动位置、stale 透明度）；不要用在需要 React diff 兜底的结构化内容上。

> 来源：[zustand README — Transient Updates](https://github.com/pmndrs/zustand)；Maka `use-app-shell-session-ui-selector.ts`（state-identity 缓存的 `useSyncExternalStore` 等价实现）；Open Cowork `selectors.ts`（`useShallow` 用法）。

---

## 四、其它机会清单（按价值/成本排序）

### （高价值·1）身份稳定的 transcript 投影层（Maka）

`createTranscriptProjection` 从 messages 派生 turn，对值未变的 turn **返回同一对象引用**（按 turnId 逐项比对）。即便上游因 IPC 刷新重建了数组、丢失引用，下游 `memo` 仍不失效。
- Maka `transcript-projection.ts`（`reconcileTurnIdentities`、`valuesEqual`）。
- **比 Nova `_revision`+memo 更强**：在 memo 层之前就在数据层保证身份；尤其解决「IPC 全量刷新后引用全断」这类 Nova 明确会失效的场景。
- 适用性：高。风险：中（`valuesEqual` 必须写对，漏报「已变」会同时漏渲染并污染 WeakMap 缓存）。

### （高价值·2）强制尾部行常驻（Cline）

Virtuoso 配 `increaseViewportBy.bottom = MAX_SAFE_INTEGER` 保证最新（流式）行恒挂载，`scrollTo(bottom)` 永远有目标，消除「追加未测高项 → 滚到底差一条 → 回弹」。
- 在 react-virtual 里等价于自定义 `rangeExtractor` 无条件把最后一个 index 纳入范围。
- **本清单里价值/改动比最高的一项**。适用性：高。风险：低。

### （高价值·3）每会话几何缓存，喂给 `estimateSize`（Maka）

按「会话 id + 布局 key（阅读栏宽度:density）」缓存每条消息实测高度与 gap。重进同一会话时，未挂载 prefix 用一个 spacer 占位、各条 intrinsic size 已知，首帧滚动条/总高即正确（LRU 限 12 会话）。
- Maka `turn-size-index.ts`。
- **与 Nova 现有虚拟化天然兼容**：把缓存的实测高度作为 `@tanstack/react-virtual` 的 `estimateSize`/`measureElement` 初值，消除重进会话的动态测高回流。关键纪律：布局 key 按阅读栏宽度而非滚动容器宽度。
- 适用性：中–高。风险：低–中。

### （高价值·4）低风险工具调用聚合为紧凑行（Cline）

把连续的 read/list/search/definition 等「低风险」工具调用折叠成一个 `ToolGroupRenderer` 行：一行摘要头 + 每工具一行（图标+路径，省略号截断），正在执行的在内联打字。整组是虚拟化列表的**一个** item。
- Cline `ToolGroupRenderer.tsx`、`messageUtils.ts`（`groupLowStakesTools`/`groupMessages`）。
- **直击「数百次工具调用」场景**：既减少顶层 item 数，又把每工具从「代码折叠块」降为「一行」。
- 适用性：高。风险：低–中（注意与 `_revision` 记忆化协调：组 revision 只在增/删/改工具时 bump）。

### （高价值·5）长代码 / 输出块的 windowShade 折叠 + 内部滚动稳定（Roo Code）

高于 500px 的代码块自动折叠（`min-height: 3em` + `transition: height 0.2s` 防布局抖）；并在流式 `source` 更新时保持块**内部**滚动稳定（用户在增长中的终端输出里向上滚时，下一段不把视图拽回底部）。
- Roo `CodeBlock.tsx`（`WINDOW_SHADE_SETTINGS`、`wasScrolledUpRef`）。
- 适用性：高。风险：低–中（纯组件级，与 Nova `contain:paint` 叠加）。

### （高价值·6）把 `highlightLineCached` 接入 markdown 代码块路径（Nova 自身缺口）

`MarkdownRenderer.tsx:94` 对代码块每行调用**未缓存**的 `highlightLine`；而 `highlightCache.ts` 的 2000 条 LRU 已存在，并已在 `StreamingFileCard`、`inspector/FilesTab` 使用。长对话里滚动/重挂的历史代码块每次重挂都重新 tokenize。
- 接入后，虚拟化重挂时直接命中缓存。
- 适用性：高。风险：低（改动局部、机械）。

### （高价值·7）`useDeferredValue` 用于派生/容器状态（非 rAF tail）

对**新消息追加 / live↔static 分层翻转时**触发昂贵子树协调的「列表引用」，以及「跳到底部提示是否出现」等派生状态用 `useDeferredValue`；用 `isStale` 驱动列表轻微透明度。
- **不要 defer rAF 打字机控制的流式 tail**（双重门控、增加 token 显示延迟，并与 rAF 打架）。
- 前提：defer 的子树必须 `React.memo`，否则紧急渲染仍会带新引用穿透。
- 来源：[React 文档 useDeferredValue](https://react.dev/reference/react/useDeferredValue)。适用性：中–高。风险：中（双渲染成本、deferred/transition 组合为 no-op 等坑）。

### （中低风险·1）`content-visibility: auto` 叠加在已挂载的历史行（Maka / Nolan Lawson）

虚拟化已卸载离屏行；本项针对**已挂载但不绘制**的行（overscan 带、流式时活跃 tail 上方的冻结行）做 paint/layout 跳过。配 `contain-intrinsic-size`（从测高缓存取值）防滚动条跳动。
- **不要**当作虚拟化的替代（Maka 那条路放弃分页、全量驻留内存，Nova 的 240 窗口化更省内存）。
- 来源：[Nolan Lawson](https://nolanlawson.com/2024/09/18/improving-rendering-performance-with-css-content-visibility/)、[web.dev](https://web.dev/articles/content-visibility)。适用性：中。风险：中（intrinsic size 不准则滚动条抖动；Nova 已手动作锚点修正，可控）。

### （中低风险·2）markdown 流水线 `React.lazy` + Suspense（Maka / Open Cowork）

把重的 markdown 渲染器 code-split，首次 `<Markdown>` 挂载时才解析求值；Suspense fallback 显示原始文本。Nova 自研高亮器本就轻，收益主要在**首屏/包体积**而非流式吞吐。
- 适用性：视 Nova 是否仍 eager 打包 markdown 解析器 + katex 而定。风险：低。

### （中低风险·3）Mermaid 渲染预算（Maka）

每文档最多 3 张自动渲染、单张源 ≤4KB、总量 ≤8KB；超额则栅栏语言改写为延迟标记，仅渲染源码 + 「渲染」按钮，且仅在非流式时套用。防止多/大图的同步布局造成卡顿。
- 适用性：高（若 Nova 内联渲染 mermaid/图）。风险：低。

### （中低风险·4）稳定事件回调（useEvent 模式）

父组件把每渲染重建的回调经 ref 路由并以 `useCallback([], …)` 包出，使 memoized 子项的函数 prop 身份稳定，不必要求每个调用方都用 `useCallback`。
- Maka `chat-view.tsx`。适用性：中。风险：低。

### （中低风险·5）setState 幂等短路（Cline）

`applyMessage` 在 partial 过期/重复（旧 seq/epoch/已应用）时返回**同一 state 对象引用**，React 18 的 `Object.is(prev,next)` 直接跳过提交。与 Nova 的 delta 合并互补：去重判定放在 `setState` 更新器内部而非 effect 里，保证「零渲染」而非「渲染后忽略」。
- 适用性：中。风险：低。

### （中低风险·6）空列表首帧快路径（Cline）

新任务、列表为空时，把「Thinking…」加载行作为**虚拟化器之外的普通绝对定位元素**绘制，避免冷启动虚拟化器要几帧才测高绘出首项，造成可见延迟。
- 适用性：中。风险：低。

### （中低风险·7）代码块容器定向 `contain: layout style`（Roo Code）

只对 `div:has(> pre)` 这种代码块包裹层做 `contain: layout style`（而非全局），更精准地隔离逐 token 增长的代码块回流。需校验不裁切复制按钮/悬停 affordance。
- 适用性：中。风险：低（纯 CSS）。

---

## 五、明确不要借鉴（劣于 Nova，回退项）

| 做法 | 出处 | 为何不借鉴 |
|---|---|---|
| 全量 state 推送 + `deepEqual` memo + 向每行传 `lastModifiedMessage` | Cline / Roo | 每帧全可见行重渲染；Cline 有已记录缺陷 #10795（长上下文白屏、单次推送 17.2MB）。Nova 的 `_revision` + 分页 + delta 合并正是其反面 |
| 全量 react-markdown 重解析 | Roo / Open Cowork | O(L²) 流式；Nova 增量 prefix+tail 更细 |
| 全量 highlight.js / `highlightAuto` | Open Cowork / Roo | Nova 自研逐行正则高亮更轻 |
| `scrollIntoView` 自动滚动 | Open Cowork | 触发父级全树同步 layout；Nova 用 `scrollTo` |
| 无虚拟化、全量驻留 DOM | Open Cowork | Nova 虚拟化 + 窗口化更省 |
| 单级（仅渲染端）delta 合并、字符串累加 | Open Cowork | 每帧 O(L) 拼接；Nova 两级合并 + 原地 mutate 更优 |
| 运行时 styled-components | Roo | 慢于 Nova 的 Tailwind/静态 CSS |
| `setInterval` 批量 / `setTimeout(0)` 延迟 / 朴素 `React.memo` / `WeakRef` 消息 / 给高亮器上 Web Worker（除非 profile 显示 >3–4ms）| 各类博客 | Nova 已有更优等价物，或引入非确定性破坏虚拟化身份 |
| 给列表重新加回 layout 动画 | — | Nova 已正确移除 |

---

## 六、建议推进顺序

1. 根因·1 + 根因·2（流式热路径剥离 + 精确订阅）：流式热路径剥离 + `subscribeWithSelector`/transient。这是 60Hz/秒提交的根因修复，所有后续优化的前提。先落实再测量。
2. 高价值·2（尾部行常驻）：尾部行常驻 `rangeExtractor`——改动极小、收益直接。
3. 高价值·6（高亮缓存接入代码块）：`highlightLineCached` 接入代码块——局部、机械、低风险。
4. 高价值·3（每会话几何缓存）：每会话几何缓存喂 `estimateSize`——重进会话即时。
5. 高价值·4 + 高价值·5（工具聚合 + 长输出折叠）：工具调用聚合 + 长输出折叠——针对「数百工具调用 / 超长输出」这两个长对话主要 DOM 成本。
6. 高价值·1（身份稳定投影层）：身份稳定投影层——与根因修复配套，处理 IPC 全量刷新场景。
7. 高价值·7 + 中低风险·1（useDeferredValue + content-visibility）：`useDeferredValue`（容器/派生态）+ `content-visibility`（冻结行）——测量驱动，谨慎推进。
8. **中低风险·其余**：mermaid 预算、lazy markdown、稳定回调、幂等短路、首帧快路径、定向 contain——按需穿插。

> 每一步落地前先在 profiler 下取证（React `<Profiler>` 的 commit 时长 + LoAF 的 blockingDuration / script 归因），确认目标瓶颈后再动手；避免「测都没测就改」。

---

## 七、关键文件索引

### Nova（本仓库）
- 列表/分层：`src/renderer/features/chat/{ChatPanel,VirtualMessageList,MessageItem,messageRenderTier}.tsx`
- 流式：`src/renderer/stores/chat/slices/streamSlice.ts`、`src/renderer/lib/streamDeltaBuffer.ts`、`src/main/agent/events/mainDeltaCoalescer.ts`、`src/renderer/hooks/useStreamingRenderPool.ts`
- markdown/高亮：`src/renderer/features/chat/{incrementalMarkdown,MarkdownRenderer}.tsx`、`src/renderer/features/diff/syntaxHighlight.ts`、`src/renderer/lib/highlightCache.ts`
- 滚动：`src/renderer/features/chat/autoScroll.ts`

### 对标仓库（GitHub）
- Maka：`maka-agent/maka-agent`（`packages/ui/src/{transcript-projection,chat-view,chat-turn,turn-size-index,turn-size-warmup,arrival-bottom-pin,progressive-turn-mount}.ts(x)`、`apps/desktop/src/renderer/{app-shell-session-ui-state,use-app-shell-session-ui-selector,app-shell-session-events,chat-message-surface}.ts(x)`、`maka-tokens.css` L1483–1520）
- Open Cowork：`OpenCoworkAI/open-cowork`（`src/renderer/components/{ChatView,MessageCard,MessageMarkdown,message/CodeBlock,message/ContentBlockView}.tsx`、`src/renderer/store/{index,selectors}.ts`、`src/renderer/hooks/useIPC.ts`）
- Cline：`cline/cline`（`apps/vscode/webview-ui/src/components/chat/chat-view/components/{layout/MessagesArea,messages/ToolGroupRenderer,...}.tsx`、`…/messageReducer.ts`、缺陷讨论 #10795）
- Roo Code：`RooCodeInc/Roo-Code`（`webview-ui/src/hooks/useScrollLifecycle.ts`、`webview-ui/src/components/{chat/ChatView,common/CodeBlock,common/MarkdownBlock}.tsx`、`webview-ui/src/utils/highlighter.ts`）

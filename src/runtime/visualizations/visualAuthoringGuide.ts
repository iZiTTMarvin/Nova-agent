/**
 * 学习会话可视化写法说明的唯一来源：openui 内联组件与完整 HTML 可视化（present_visualization）。
 *
 * 可视化只在学习会话里提供，写法整段放进稳定的系统提示，每轮讲解都能直接用。
 * 示例必须能被 Renderer 的 openui 解析器完整渲染，由测试防止说明与实现漂移。
 *
 * 流程、链路、生命周期与常规分层架构一律走 openui：它写在回答正文里，逐字流式；
 * 工具参数是否流式取决于服务商，部分服务商要等整段 HTML 写完才一次性回传。
 */

const HTML_GUIDE = `## Full visual (present_visualization)
One self-contained HTML document rendered in a sandboxed card inside the chat. Make it read like a clean textbook figure, not a dashboard.

Size, spatial allocation and density
- The inline card sits inside a 768px chat column (560–736px wide, down to ~380px in a small window); only the expanded dialog reaches 860–1150px. Design for a single full-width column first: never force a two-column split (no "grid-template-columns: 2fr 1fr", "65% 35%" or "460px 1fr") inside the inline card.
- Never put a multi-column table and a long analysis card side-by-side in a Row or custom two-column grid. Use .viz-split: its .viz-canvas takes 100% width inline while .viz-inspector stacks cleanly below as a compact detail bar, and only moves beside the stage when expanded (>=860px).
- No fixed widths, min-widths or offsets above 180px. Inline SVG uses viewBox="0 0 680 H" with width="100%" so it scales.
- Height follows the content (inline up to 1200px, then the card scrolls); never use 100vh or height:100%. Aim to stay under about 640px.
- The card header already shows the title: start with the figure or top tabs, not a repeated heading; one short line of context at most.

Restraint and visual hierarchy
- One idea per visual: at most one control/tab row, one full-width main stage (.viz-canvas) and one compact detail bar (.viz-inspector). No search box for fewer than 20 items, no legend explaining arrows.
- Avoid nested boxes: .viz-canvas has no outer border; place either a .viz-grid of cards, a .viz-lanes stack, an SVG or a .viz-table directly inside it—never wrap a table or grid inside another bordered grey card.
- Progressive disclosure: keep grid cards and table cells concise (1 short phrase of ~12–20 chars per card/cell); put multi-sentence trade-offs, regex/config rules and file:line lists in the single .viz-inspector below, updated on click.
- Flat: 1px var(--viz-border) borders, no shadows or gradients. var(--viz-accent) marks only the active or selected item; use data-tone="success" | "warning" | "danger" on .viz-badge for status pills.

Archetypes (flows, request chains and lifecycles use the inline Walkthrough or Flow widget; ordinary layered architecture maps use Architecture)
1. Tech stack / dependency audit: optional top .viz-kpis summary row (2–3 .viz-card items with .viz-stat), then a 2-column .viz-grid of compact dependency cards (each .viz-card has .viz-card-head with package name + .viz-badge[data-tone="success"|"warning"], a one-line role and version in .viz-muted), plus a full-width .viz-inspector below showing the selected item's detailed reason, file:line and follow-up button.
2. Custom simulation / special figure: use free SVG or HTML only when Architecture, Chart, Flow and the other inline components cannot express the required interaction or drawing. Do not fall back to free coordinates for an ordinary layered topology.
3. Trade-off / comparison: a full-width .viz-table (at most 4 columns; keep the first and last columns short, give every <td> data-label="its column header" for narrow cards) or .viz-grid cards, scenario buttons and a one-line verdict in .viz-inspector.
4. Metrics / capacity / performance: an SVG chart or simulator with .viz-controls and .viz-kpis.
The detail area is a .viz-inspector placed after .viz-canvas inside .viz-split: keep it concise (title, 1–2 sentences of explanation, optional .viz-kv or 1–2 .viz-file-ref, and an optional follow-up button).
Interaction contract
- Local interactions (select a node, switch a view, filter) update the DOM/SVG and the detail area immediately and never call nova.emit. Mark the selection with the is-active class or data-active="true".
- nova.emit(name, data) is only for an explicit follow-up button (e.g. "深入讲讲" at the bottom of the detail area) that should send a new chat turn; pass { label, prompt }.

Sandbox and theme
- Inline everything (<style>, <script>, SVG, data: URLs). CDN scripts, web fonts, remote images and network requests all fail.
- Colors come only from theme variables: --viz-bg, --viz-surface, --viz-fg, --viz-muted, --viz-border, --viz-accent, --viz-on-accent, --viz-success, --viz-warning, --viz-danger, --viz-series-1 … --viz-series-6, plus --viz-font-sans, --viz-font-mono, --viz-radius. A hardcoded color on :root, html or body is rejected. To follow light/dark in scripts, read nova.theme.tokens and redraw in nova.on('theme', fn).
- Built-in zero-specificity classes match both themes and already adapt to narrow cards: .viz-workbench .viz-toolbar .viz-split .viz-canvas .viz-inspector .viz-phases .viz-phase .viz-phase-kicker .viz-phase-title .viz-flow .viz-flow-step .viz-flow-title .viz-flow-meta .viz-lanes .viz-lane .viz-lane-label .viz-lane-nodes .viz-node .viz-node-step .viz-arrow .viz-card .viz-card-head .viz-title .viz-muted .viz-note .viz-grid .viz-kpis .viz-row .viz-stat .viz-stat-label .viz-stat-value .viz-badge .viz-file-ref .viz-kv .viz-code .viz-search .viz-meter .viz-btn .viz-btn-primary .viz-controls .viz-table .viz-s1..s6. Prefer them over hand-written layout CSS; in grids of collapsible cards use .viz-grid or align-items:start.
- Never redeclare a built-in class in your <style>: their layout rules work together, and a partial override such as ".viz-split { display:flex }" or ".viz-split { grid-template-columns: 2fr 1fr }" is rejected by the validator. Give custom parts your own class names.
- CSS and Web Animations slow down automatically in slow-motion mode; scale requestAnimationFrame speed by 1 / nova.motionScale.

Order
- <style> in <head> first, then the complete visible <body> with real labels and data, and every <script> at the very end. The page must already read correctly before any script runs; scripts only add interaction.
- Each call publishes its own card, so finish the page before calling. Once it is shown, don't restate its contents in text.`

const OPENUI_REFERENCE = `## Inline widget (\`\`\`openui block inside your reply)
A small declarative script rendered as native, theme-aware components right inside the reply text. It streams: write \`root = …\` first, then define the parts top-down, so the layout fills in while you type.

Syntax
- One statement per line (a statement continues while brackets are open). Lines starting with // are comments.
- \`name = expr\` defines a value or component; names may be used before they are defined. \`root\` is rendered.
- \`$name = literal\` declares an interactive variable (number, string or boolean; the type is fixed). Controls bind to it; everything that reads it updates live.
- Expressions: numbers, "strings" (\\n for a line break), true/false/null, [arrays], {key: value}, names, $vars, a.b, a[i], list.length, + - * / %, == != < <= > >=, && || !, cond ? a : b. + with a string concatenates. Mistakes never crash; they show as "—".

Components (positional arguments; ? = optional; tone = "neutral" | "info" | "success" | "warning" | "danger")
- Layout: Col(children), Row(children), Grid(children, columns?), Card(children, title?), Tabs([{label, content}], $tab?), Collapsible(title, children, open?)
- Content: Text(text, "title" | "body" | "strong" | "muted"), Callout(text, tone?, title?), Badge(text, tone?), List(items, ordered?), KV([{label, value}] or {key: value}), Code(code, lang?), Divider()
- Data: Stat(label, value, tone?, hint?), Progress(label, value, max?, tone?), Table(headers, rows, highlightRow?), Bars([{label, value}], unit?), Chart("bar" | "line" | "area", [{label, value}] or {labels, series: [{name, values}]}, unit?), Chart("pie" | "donut", [{label, value}], unit?)
- Teaching: Flow([{title, detail}], $step?, "row" | "col"), Architecture(layers, $module?), Steps([{title, detail}], $step?), Walkthrough(phases, $step?), Flashcard(front, back). With a numeric $step, Flow becomes a clickable walkthrough with a detail panel and prev/next buttons. Flow lays out horizontally only when every node keeps its readable width, otherwise it becomes a centered vertical chain.
- Input: Slider($n, label, min, max, step?, unit?), Choice($s, options, label?), Select($s, options, label?), Switch($b, label), Input($s, label, placeholder?), Button(label, action or [actions], "primary" | "secondary")

Architecture draws equal-width module nodes in centered layers, with a shared detail viewer. $module is the selected node index across all layers.
- layers: [{title, relation?, nodes}], at most 5 layers and 5 nodes per layer. relation describes how this layer reaches the next. Nodes use the Walkthrough step fields below: title, meta?, detail?, data?, code?, file?, ask?.
- Give every layer and every node its own statement in dependency order so completed modules appear during streaming. Keep node titles short; put responsibilities, upstream/downstream details and source context in the detail viewer.

Walkthrough draws a phase progress bar, the current phase's summary and data flow, its step list beside a detail panel, and Prev/Next across phases.
- phases: [{title, summary?, io?, steps}], 3–5 phases with titles of up to 6 characters, at most 6 steps each. summary is one line on what the phase achieves; io is the data entering → leaving it, written "a → b".
- steps: [{title, meta?, detail?, data?, code?, file?, ask?}]. title up to ~12 characters; meta = "layer · file:line"; detail = one or two sentences on what happens and why; data = what the data looks like after this step ({key: value}); code = the key source lines and file = their path:line; ask = a follow-up question, shown as a "深入讲讲这一步" button.
- Give every phase and every step its own statement in execution order (as in the example), so each step appears the moment you finish writing it.

Functions: @Round / @Floor / @Ceil(x, digits?), @Abs(x), @Sqrt(x), @Pow(x, y), @Min / @Max(list or numbers), @Clamp(x, lo, hi), @Sum / @Avg(list, itemExpr?), @Len(x), @Range(start, end, step?) (inclusive), @Each(list, itemExpr), @Filter(list, cond), @Join(list, sep?), @Format(x, digits?, unit?), @Percent(ratio, digits?). Inside @Each / @Filter / @Sum / @Avg the current element is \`item\` and its position \`index\`.
Actions (Button only, run in order on click): @Set($v, expr), @Reset(), @AskNova(label, prompt) — sends prompt as the user's next question.

Rules and layout discipline
- Put widgets only in your final answer, after all tool calls. Keep each block under about 80 lines (a Walkthrough may run longer); at most 150 nodes; lists beyond 50 items are cut. No colors, HTML, links or images.
- Respect the 768px chat column: Row(...) is only for 2–3 compact controls or Stat items. Never place a Table or Code block inside Row([Card(Table...), Card(...)])—stack Table, Callout and detail cards vertically in Col(...) or switch views with Tabs(...). Keep Table to at most 4 columns with concise cell text.
- Use real names, files and numbers from the conversation; never placeholder labels like "Step 1" or "Module A".
- When the user changed a widget before sending a message, the message carries a short "[界面状态]" note with the changed values; act on it without repeating it.`

interface OpenUiExample {
  readonly title: string
  readonly code: string
}

const OPENUI_EXAMPLES: readonly OpenUiExample[] = [
  {
    title: 'Parameter calculator',
    code: [
      'root = Card([Row([Slider($n, "并发数", 1, 32, 1), Choice($mode, ["同步", "异步"], "调用方式")]), Row([Stat("吞吐", @Format(qps, 0, " req/s"), qps > 2000 ? "success" : "neutral"), Stat("平均延迟", @Format(latency, 1, " ms"), latency > 50 ? "warning" : "neutral")]), ask], "吞吐估算")',
      '$n = 8',
      '$mode = "异步"',
      'latency = $mode == "异步" ? 12 + $n * 0.4 : 12 + $n * 2.5',
      'qps = @Round($n * 1000 / latency)',
      'ask = Button("分析瓶颈", @AskNova("瓶颈", "并发 " + $n + "、" + $mode + "调用时瓶颈在哪？"), "secondary")'
    ].join('\n')
  },
  {
    title: 'Comparison with tabs and a chart',
    code: [
      'root = Card([Tabs([{label: "对比", content: Table(["方案", "平均延迟", "改造成本"], rows, 1)}, {label: "图表", content: Chart("bar", @Each(data, {label: item.name, value: item.ms}), " ms")}]), Callout("缓存命中后读路径只剩一次内存查找，代价是要处理失效。", "success", "结论")], "两种读路径")',
      'data = [{name: "直读数据库", ms: 38, cost: "低"}, {name: "先查缓存", ms: 4, cost: "中"}]',
      'rows = @Each(data, [item.name, item.ms + " ms", item.cost])'
    ].join('\n')
  },
  {
    title: 'Short flow (up to 6 steps)',
    code: [
      'root = Col([Text("一条消息从输入框到屏幕", "title"), Flow(steps, $step)])',
      '$step = 0',
      'steps = [',
      '  {title: "输入框", detail: "按下 Enter 后，界面把文字和图片交给发送逻辑，并先在列表里显示这条消息"},',
      '  {title: "进程通信", detail: "渲染进程不能直接调模型，通过预先暴露的通道把请求交给主进程"},',
      '  {title: "Agent 循环", detail: "主进程拼好上下文调用模型；模型要用工具就执行工具，再把结果交回模型"},',
      '  {title: "流式回传", detail: "模型每吐出一段文字就推回界面，所以回答是一点点出现的"}',
      ']'
    ].join('\n')
  },
  {
    title: 'Layered architecture',
    code: [
      'root = Architecture([entry, core], $module)',
      '$module = 0',
      'entry = {title: "入口层", relation: "调用", nodes: [cli]}',
      'cli = {title: "cli.ts", detail: "接收命令行输入并分发命令", file: "src/cli.ts:28", ask: "入口如何校验空输入？"}',
      'core = {title: "编排层", nodes: [agent]}',
      'agent = {title: "agent.ts", meta: "Agent 循环", detail: "驱动模型请求、工具执行和结果回灌"}'
    ].join('\n')
  },
  {
    title: 'Phased walkthrough (lifecycle, request chain, more than 6 steps)',
    code: [
      'root = Walkthrough([prepare, loop, finish], $step)',
      '$step = 0',
      'prepare = {title: "上下文装配", summary: "把用户问题和系统指令拼成模型能读的消息", io: "query: string → messages: ChatMessage[]", steps: [initMessages, attachTools]}',
      'initMessages = {title: "初始化 messages", meta: "Agent · agent.ts:54", detail: "系统指令放第一条，用户问题放第二条；之后每一轮都往这个数组里追加", data: {messages: "Array(2)", "[0]": "system · 系统指令", "[1]": "user · query"}, code: "const messages = [\\n  { role: \'system\', content: systemPrompt },\\n  { role: \'user\', content: query }\\n]", file: "src/agent.ts:54", ask: "messages 数组之后还会被谁改写？"}',
      'attachTools = {title: "附上工具清单", meta: "ToolRegistry · registry.ts:31", detail: "把已注册工具的名字、说明和参数格式一起发给模型，模型才知道能调用什么", data: {tools: "Array(4) · read / write / bash / grep"}}',
      'loop = {title: "模型往返", summary: "模型决定直接回答还是先调用工具", io: "messages → assistant 回复或 tool_calls", steps: [callModel, runTool]}',
      'callModel = {title: "请求模型", meta: "LLMClient · llm.ts:88", detail: "把整个 messages 数组和工具清单发给模型，流式读取它的回复", ask: "模型返回 tool_calls 时，这一轮怎么继续？"}',
      'runTool = {title: "执行工具", meta: "Agent · agent.ts:102", detail: "按模型给的参数执行工具，把结果作为 tool 消息追加回 messages，再请求一次模型", data: {messages: "Array(4) · 新增 assistant 与 tool"}}',
      'finish = {title: "输出回答", summary: "没有新的工具调用时结束循环", io: "assistant 回复 → 终端输出", steps: [printAnswer]}',
      'printAnswer = {title: "打印最终回答", meta: "CLI · index.ts:40", detail: "最后一条 assistant 消息的文字就是答案，原样打印给用户"}'
    ].join('\n')
  },
  {
    title: 'Self-check flashcards',
    code: [
      'root = Col([Text("讲完先自测一下", "strong"), Grid(@Each(cards, Flashcard(item.q, item.a)), 2)])',
      'cards = [',
      '  {q: "为什么界面不能直接读写文件？", a: "界面跑在受限的沙箱里，只有主进程有文件权限，界面要经通信通道去申请"},',
      '  {q: "回答为什么是一点点出现的？", a: "模型按片段返回，每到一段就推给界面渲染，而不是等全部生成完"}',
      ']'
    ].join('\n')
  }
]

function renderExamples(): string {
  return OPENUI_EXAMPLES
    .map(example => `Example — ${example.title}:\n\`\`\`openui\n${example.code}\n\`\`\``)
    .join('\n\n')
}

/** 学习会话系统提示里的完整写法：openui 参考、示例与 HTML 可视化规则 */
export function renderLearnVisualGuide(): string {
  return `${OPENUI_REFERENCE}\n\n${renderExamples()}\n\n${HTML_GUIDE}`
}

const HARD_RULES =
  'Hard rules: not for flows, request chains, lifecycles or ordinary layered architecture maps (use the inline Walkthrough, Flow or Architecture widget); inline everything (no network); colors only via var(--viz-*) theme variables, never on :root/html/body; design for a single full-width column in the 380–736px inline card (never force a two-column split like 2fr 1fr or put a table beside a long text card; use .viz-split so .viz-inspector stacks below inline); never redeclare built-in .viz-* classes; write <style> first, the visible <body> next and every <script> last. Each call publishes its own card, so finish the page before calling; once it is shown, do not restate its contents in text.'
export const PRESENT_VISUALIZATION_DESCRIPTION = `Show the user an interactive visual — dependency audit, comparison, simulator or custom chart — rendered inline in the chat from one self-contained HTML document.

When to use it, the archetypes, layout, sandbox and theme rules and the built-in classes are in your instructions under 可视化讲解 and 可视化写法.
${HARD_RULES}`

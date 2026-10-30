/**
 * 学习会话可视化写法说明的唯一来源：openui 内联组件与完整 HTML 可视化（present_visualization）。
 *
 * 可视化只在学习会话里提供，写法整段放进稳定的系统提示，每轮讲解都能直接用。
 * 这段文字每轮都占上下文，只写模型照做就能出对图的规则；「何时画、画哪档」归教学提示，这里不重复。
 * 示例必须能被 Renderer 的 openui 解析器完整渲染，由测试防止说明与实现漂移。
 *
 * 流程、链路、生命周期与常规分层架构一律走 openui：它写在回答正文里，逐字流式；
 * 工具参数是否流式取决于服务商，部分服务商要等整段 HTML 写完才一次性回传。
 */

const HTML_GUIDE = `## Full visual (present_visualization)
One self-contained HTML document shown in a sandboxed card in the chat. It should read like a clean textbook figure, not a dashboard.

Layout
- The inline card is 380–736px wide; only the expanded dialog reaches 860–1150px. Design one full-width column: no fixed two-column splits (2fr 1fr, 65% 35%, 460px 1fr) and no table beside a long text card. Use .viz-split: .viz-canvas takes the full width and .viz-inspector stacks below as a compact detail bar, moving beside the stage only when expanded.
- No fixed widths or offsets above 180px; inline SVG uses viewBox="0 0 680 H" with width="100%". Height follows the content (aim under ~640px); never 100vh or height:100%.
- The card header already shows the title: start with the figure or a tab row.
- One idea per visual: at most one control row, one .viz-canvas and one .viz-inspector. Don't nest bordered boxes; put a .viz-grid, .viz-lanes, SVG or .viz-table directly in the canvas. Cards and cells hold one short phrase (~12–20 chars); explanations, rules and file:line lists go in the .viz-inspector, updated on click.
- Flat: 1px var(--viz-border) borders, no shadows or gradients; var(--viz-accent) only marks the selected item; status pills are .viz-badge with data-tone="success" | "warning" | "danger".

Archetypes (flows, lifecycles and layered architecture use the inline Flow, Walkthrough or Architecture widget instead)
1. Dependency audit: optional .viz-kpis row of 2–3 .viz-card items with .viz-stat, a 2-column .viz-grid of .viz-card items (.viz-card-head with name + .viz-badge, one-line role and version in .viz-muted), and a .viz-inspector with the selected item's reason, .viz-file-ref and follow-up button.
2. Trade-off comparison: a full-width .viz-table (at most 4 columns, every <td> has data-label="its column header") or .viz-grid cards, scenario buttons and a one-line verdict in the .viz-inspector.
3. Metrics or simulator: an SVG chart or simulation with .viz-controls and .viz-kpis.
4. Custom figure: free SVG or HTML only when no inline widget can express it.

Interaction
- Local interactions (select, switch view, filter) update the page directly; mark the selection with the is-active class or data-active="true".
- nova.emit(name, { label, prompt }) only from an explicit follow-up button such as "深入讲讲" in the detail bar; it sends a new chat turn.

Sandbox and theme
- Inline everything (<style>, <script>, SVG, data: URLs); CDN scripts, web fonts, remote images and network requests fail.
- Colors only from theme variables: --viz-bg, --viz-surface, --viz-fg, --viz-muted, --viz-border, --viz-accent, --viz-on-accent, --viz-success, --viz-warning, --viz-danger, --viz-series-1 … --viz-series-6, plus --viz-font-sans, --viz-font-mono, --viz-radius. A hardcoded color on :root, html or body is rejected. Scripts read nova.theme.tokens and redraw in nova.on('theme', fn).
- Built-in zero-specificity classes match both themes and adapt to narrow cards: .viz-workbench .viz-toolbar .viz-split .viz-canvas .viz-inspector .viz-phases .viz-phase .viz-phase-kicker .viz-phase-title .viz-flow .viz-flow-step .viz-flow-title .viz-flow-meta .viz-lanes .viz-lane .viz-lane-label .viz-lane-nodes .viz-node .viz-node-step .viz-arrow .viz-card .viz-card-head .viz-title .viz-muted .viz-note .viz-grid .viz-kpis .viz-row .viz-stat .viz-stat-label .viz-stat-value .viz-badge .viz-file-ref .viz-kv .viz-code .viz-search .viz-meter .viz-btn .viz-btn-primary .viz-controls .viz-table .viz-s1..s6. Prefer them to hand-written layout CSS and never redeclare them in your <style> (a partial override such as ".viz-split { display:flex }" is rejected); give custom parts your own class names.
- CSS and Web Animations slow down automatically in slow-motion mode; scale requestAnimationFrame speed by 1 / nova.motionScale.

Order: <style> in <head>, then the complete visible <body> with real labels and data, every <script> last; the page must read correctly before any script runs. Each call publishes its own card, so finish the page before calling.`

const OPENUI_REFERENCE = `## Inline widget (\`\`\`openui block inside your reply)
A small declarative script rendered as native, theme-aware components inside the reply. It streams: write \`root = …\` first, then define the parts top-down, so the layout fills in while you type.

Syntax
- One statement per line (a statement continues while brackets are open); // starts a comment.
- \`name = expr\` defines a value or component; names may be used before they are defined; \`root\` is rendered.
- \`$name = literal\` declares an interactive variable (number, string or boolean; the type is fixed). Controls bind to it and everything that reads it updates live.
- Expressions: numbers, "strings" (\\n for a line break), true/false/null, [arrays], {key: value}, names, $vars, a.b, a[i], list.length, + - * / %, == != < <= > >=, && || !, cond ? a : b. + with a string concatenates. Mistakes never crash; they show as "—".

Components (positional arguments; ? = optional; tone = "neutral" | "info" | "success" | "warning" | "danger")
- Layout: Col(children), Row(children), Grid(children, columns?), Card(children, title?), Tabs([{label, content}], $tab?), Collapsible(title, children, open?)
- Content: Text(text, "title" | "body" | "strong" | "muted"), Callout(text, tone?, title?), Badge(text, tone?), List(items, ordered?), KV([{label, value}] or {key: value}), Code(code, lang?), Divider()
- Data: Stat(label, value, tone?, hint?), Progress(label, value, max?, tone?), Table(headers, rows, highlightRow?), Bars([{label, value}], unit?), Chart("bar" | "line" | "area", [{label, value}] or {labels, series: [{name, values}]}, unit?), Chart("pie" | "donut", [{label, value}], unit?)
- Teaching: Flow([{title, detail}], $step?, "row" | "col"), Architecture(layers, $module?), Steps([{title, detail}], $step?), Walkthrough(phases, $step?), Flashcard(front, back). A numeric $step turns Flow into a clickable walkthrough with prev/next.
- Input: Slider($n, label, min, max, step?, unit?), Choice($s, options, label?), Select($s, options, label?), Switch($b, label), Input($s, label, placeholder?), Button(label, action or [actions], "primary" | "secondary")
- Architecture layers: [{title, relation?, nodes}], at most 5 layers of 5 nodes; relation says how a layer reaches the next; $module is the selected node index across layers.
- Walkthrough phases: [{title, summary?, io?, steps}], 3–5 phases (titles up to 6 characters, at most 6 steps each); summary is one line, io is "data in → data out".
- Architecture nodes and Walkthrough steps share fields {title, meta?, detail?, data?, code?, file?, ask?}: title up to ~12 characters, meta "layer · file:line", detail one or two sentences, data {key: value} after the step, code and file the key source lines, ask a follow-up shown as a "深入讲讲这一步" button.
- Give every layer, node, phase and step its own statement in execution order (as in the examples), so each appears as soon as it is written.

Functions: @Round / @Floor / @Ceil(x, digits?), @Abs(x), @Sqrt(x), @Pow(x, y), @Min / @Max(list or numbers), @Clamp(x, lo, hi), @Sum / @Avg(list, itemExpr?), @Len(x), @Range(start, end, step?) (inclusive), @Each(list, itemExpr), @Filter(list, cond), @Join(list, sep?), @Format(x, digits?, unit?), @Percent(ratio, digits?). Inside @Each / @Filter / @Sum / @Avg the current element is \`item\` and its position \`index\`.
Actions (Button only, run in order on click): @Set($v, expr), @Reset(), @AskNova(label, prompt) — sends prompt as the user's next question; use it only for explicit follow-up buttons such as "深入讲讲", never for local selection.

Rules
- Widgets go in the final answer after all tool calls. Keep a block under ~80 lines (a Walkthrough may run longer) and 150 nodes; lists beyond 50 items are cut. No colors, HTML, links or images.
- The chat column is ~736px: Row only holds 2–3 compact controls or Stat items; stack Table, Callout and cards vertically in Col or switch views with Tabs; Table keeps at most 4 columns of short text.
- Use real names, files and numbers from the conversation, never placeholder labels like "Step 1" or "Module A".
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
    title: 'Phased walkthrough (lifecycle or request chain beyond 6 steps)',
    code: [
      'root = Walkthrough([prepare, loop, finish], $step)',
      '$step = 0',
      'prepare = {title: "装配上下文", summary: "把用户问题和系统指令拼成消息数组", io: "query → messages", steps: [initMessages]}',
      'initMessages = {title: "初始化 messages", meta: "Agent · agent.ts:54", detail: "系统指令放第一条，用户问题放第二条；之后每轮都往这个数组追加", data: {messages: "Array(2)"}, code: "const messages = [system, user]", file: "src/agent.ts:54", ask: "messages 之后还会被谁改写？"}',
      'loop = {title: "模型往返", summary: "模型决定直接回答还是先调用工具", io: "messages → 回复或 tool_calls", steps: [callModel, runTool]}',
      'callModel = {title: "请求模型", meta: "LLMClient · llm.ts:88", detail: "把 messages 和工具清单发给模型，流式读取回复"}',
      'runTool = {title: "执行工具", meta: "Agent · agent.ts:102", detail: "按模型给的参数执行工具，结果作为 tool 消息追加回 messages 再请求一次", data: {messages: "Array(4)"}}',
      'finish = {title: "输出回答", summary: "没有新的工具调用时结束循环", io: "assistant 回复 → 终端", steps: [printAnswer]}',
      'printAnswer = {title: "打印回答", meta: "CLI · index.ts:40", detail: "最后一条 assistant 消息就是答案，原样打印给用户"}'
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

// 工具说明随每轮请求发送：只留最容易写错、会被校验拒绝的几条，完整规则在系统提示里
const HARD_RULES =
  'Hard rules: not for flows, lifecycles or ordinary layered architecture (use the inline Walkthrough, Flow or Architecture widget); inline everything, no network; colors only via var(--viz-*) theme variables; one full-width column (use .viz-split, never a fixed two-column split); never redeclare built-in .viz-* classes; finish the page before calling.'
export const PRESENT_VISUALIZATION_DESCRIPTION = `Show the user an interactive visual — dependency audit, comparison, simulator or custom chart — rendered inline in the chat from one self-contained HTML document.

When to use it, the archetypes, layout, sandbox and theme rules and the built-in classes are in your instructions under 可视化讲解 and 可视化写法.
${HARD_RULES}`

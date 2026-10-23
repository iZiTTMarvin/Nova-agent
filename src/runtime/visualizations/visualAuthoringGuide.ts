/**
 * 学习会话可视化写法说明的唯一来源：openui 内联组件与完整 HTML 可视化（present_visualization）。
 *
 * 可视化只在学习会话里提供，写法整段放进稳定的系统提示，每轮讲解都能直接用。
 * 示例必须能被 Renderer 的 openui 解析器完整渲染，由测试防止说明与实现漂移。
 */

const HTML_GUIDE = `## Full visual (present_visualization)
One self-contained HTML document rendered in a sandboxed card inside the chat. Make it read like a clean textbook figure, not a dashboard.

Size and layout
- The card is 560–700px wide in the chat column and shrinks to about 380px in a small window; the expanded view is wider. Design for 380–700px first: everything must read at 380px without horizontal scrolling.
- No fixed widths, min-widths or offsets above 200px (no "grid-template-columns: 150px 1fr", no "padding-left: 160px" to line things up). Use flex-wrap, minmax(0, 1fr) and repeat(auto-fit, minmax(min(100%, 200px), 1fr)). Inline SVG uses viewBox="0 0 680 H" with width="100%" so it scales.
- Height follows the content (inline up to 1200px, then the card scrolls); never use 100vh or height:100%. Aim to stay under about 700px.
- The card header already shows the title: start with the figure, not a repeated heading or a row of badges; one short line of context at most.

Restraint
- One idea per visual: at most one control row (phase tabs or Prev/Next), one stage and one detail area. No search box for fewer than 20 items, no legend explaining arrows, no decorative stats.
- At most about 7 nodes visible at once. Node labels stay short (a title of up to ~12 characters plus one meta line); explanations, payloads and file paths go in the detail area, not on the stage.
- Flat: 1px var(--viz-border) borders, no shadows or gradients, at most two levels of nested boxes. var(--viz-accent) marks only the active or selected item; use 2–3 series colors at most, each with a meaning.

Archetypes
1. Flow / request lifecycle / state machine. Up to 7 steps: one .viz-flow (vertical steps with connectors, reads at any width) or a left-to-right SVG. More steps: group them into 3–5 phases with titles of up to 6 characters; .viz-phases tabs share the width evenly and choose a phase, the stage shows only that phase's steps, and Prev/Next walks every step across phases. Never put 9+ steps on screen at once, and never build a text-only slide deck.
2. Architecture / module map / tech stack: a layered SVG (at most 5 nodes per row) or .viz-lanes (one lane per layer, at most 5 lanes); clicking a module highlights its edges and fills the detail area.
3. Trade-off / comparison: .viz-table (at most 4 columns; give every <td> data-label="its column header" so a narrow card shows each row as a labelled card) or .viz-grid cards, scenario buttons and a one-line verdict.
4. Metrics / capacity / performance: an SVG chart or simulator with .viz-controls and .viz-stat.
The detail area is a .viz-inspector placed after the stage inside .viz-split: it sits beside the stage when the card is wide and right below it when narrow. Keep it short: a one-sentence role, input → output (.viz-kv), 1–2 .viz-file-ref, optionally a few lines of .viz-code.

Skeleton for a long flow (step data lives in the script; render the first phase statically so the page reads before any script runs):
<div class="viz-workbench">
  <div class="viz-phases"><button class="viz-phase is-active" type="button"><span class="viz-phase-kicker">1</span><span class="viz-phase-title">输入与提交</span></button> … one button per phase</div>
  <div class="viz-split">
    <div class="viz-canvas"><div class="viz-flow">
      <button class="viz-flow-step is-active" type="button"><span class="viz-node-step">1</span><span><span class="viz-flow-title">输入框绑定</span><span class="viz-flow-meta">前端 · chatInput</span></span></button> … only this phase's steps
    </div></div>
    <aside class="viz-inspector"><div class="viz-title">输入框绑定</div><p class="viz-note">一句话说清它负责什么</p><dl class="viz-kv"><dt>输入</dt><dd>按键</dd><dt>输出</dt><dd>chatInput</dd></dl><span class="viz-file-ref">frontend/index.html:211</span></aside>
  </div>
  <div class="viz-toolbar"><span class="viz-note">1 / 16</span><span class="viz-row"><button class="viz-btn" type="button">上一步</button><button class="viz-btn viz-btn-primary" type="button">下一步</button></span></div>
</div>

Interaction contract
- Local interactions (select a node, switch phase, filter, toggle a view, Prev/Next) update the DOM/SVG and the detail area immediately and never call nova.emit. Mark the selection with the is-active class or data-active="true".
- nova.emit(name, data) is only for an explicit follow-up button (e.g. "深入讲讲这一步" at the bottom of the detail area) that should send a new chat turn; pass { label, prompt }.

Sandbox and theme
- Inline everything (<style>, <script>, SVG, data: URLs). CDN scripts, web fonts, remote images and network requests all fail.
- Colors come only from theme variables: --viz-bg, --viz-surface, --viz-fg, --viz-muted, --viz-border, --viz-accent, --viz-on-accent, --viz-success, --viz-warning, --viz-danger, --viz-series-1 … --viz-series-6, plus --viz-font-sans, --viz-font-mono, --viz-radius. A hardcoded color on :root, html or body is rejected. To follow light/dark in scripts, read nova.theme.tokens and redraw in nova.on('theme', fn).
- Built-in zero-specificity classes match both themes and already adapt to narrow cards: .viz-workbench .viz-toolbar .viz-split .viz-canvas .viz-inspector .viz-phases .viz-phase .viz-phase-kicker .viz-phase-title .viz-flow .viz-flow-step .viz-flow-title .viz-flow-meta .viz-lanes .viz-lane .viz-lane-label .viz-lane-nodes .viz-node .viz-node-step .viz-arrow .viz-card .viz-title .viz-muted .viz-note .viz-grid .viz-row .viz-stat .viz-stat-label .viz-stat-value .viz-badge .viz-file-ref .viz-kv .viz-code .viz-search .viz-meter .viz-btn .viz-btn-primary .viz-controls .viz-table .viz-s1..s6. Prefer them over hand-written layout CSS; in grids of collapsible cards use .viz-grid or align-items:start.
- CSS and Web Animations slow down automatically in slow-motion mode; scale requestAnimationFrame speed by 1 / nova.motionScale.

Streaming order (the user watches the page build while you write)
- <style> in <head> first, then the complete visible <body> skeleton with real labels and data, and every <script> at the very end. The page must already read correctly before any script runs; scripts only add interaction.
- Each call publishes its own card, so finish the page before calling. Once it is shown, don't restate its contents in text.`

const OPENUI_REFERENCE = `## Inline widget (\`\`\`openui block inside your reply)
A small declarative script rendered as native, theme-aware components right inside the reply text. It streams: write \`root = …\` first, then define the parts top-down, so the layout fills in while you type.

Syntax
- One statement per line (a statement continues while brackets are open). Lines starting with // are comments.
- \`name = expr\` defines a value or component; names may be used before they are defined. \`root\` is rendered.
- \`$name = literal\` declares an interactive variable (number, string or boolean; the type is fixed). Controls bind to it; everything that reads it updates live.
- Expressions: numbers, "strings", true/false/null, [arrays], {key: value}, names, $vars, a.b, a[i], list.length, + - * / %, == != < <= > >=, && || !, cond ? a : b. + with a string concatenates. Mistakes never crash; they show as "—".

Components (positional arguments; ? = optional; tone = "neutral" | "info" | "success" | "warning" | "danger")
- Layout: Col(children), Row(children), Grid(children, columns?), Card(children, title?), Tabs([{label, content}], $tab?), Collapsible(title, children, open?)
- Content: Text(text, "title" | "body" | "strong" | "muted"), Callout(text, tone?, title?), Badge(text, tone?), List(items, ordered?), KV([{label, value}] or {key: value}), Code(code, lang?), Divider()
- Data: Stat(label, value, tone?, hint?), Progress(label, value, max?, tone?), Table(headers, rows, highlightRow?), Bars([{label, value}], unit?), Chart("bar" | "line" | "area", [{label, value}] or {labels, series: [{name, values}]}, unit?), Chart("pie" | "donut", [{label, value}], unit?)
- Teaching: Flow([{title, detail}], $step?, "row" | "col"), Steps([{title, detail}], $step?), Flashcard(front, back). With a numeric $step, Flow becomes a clickable walkthrough with a detail panel and prev/next buttons.
- Input: Slider($n, label, min, max, step?, unit?), Choice($s, options, label?), Select($s, options, label?), Switch($b, label), Input($s, label, placeholder?), Button(label, action or [actions], "primary" | "secondary")

Functions: @Round / @Floor / @Ceil(x, digits?), @Abs(x), @Sqrt(x), @Pow(x, y), @Min / @Max(list or numbers), @Clamp(x, lo, hi), @Sum / @Avg(list, itemExpr?), @Len(x), @Range(start, end, step?) (inclusive), @Each(list, itemExpr), @Filter(list, cond), @Join(list, sep?), @Format(x, digits?, unit?), @Percent(ratio, digits?). Inside @Each / @Filter / @Sum / @Avg the current element is \`item\` and its position \`index\`.
Actions (Button only, run in order on click): @Set($v, expr), @Reset(), @AskNova(label, prompt) — sends prompt as the user's next question.

Rules
- Put widgets only in your final answer, after all tool calls. Keep each block under about 80 lines; at most 150 nodes; lists beyond 50 items are cut. No colors, HTML, links or images.
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
    title: 'Step-by-step walkthrough',
    code: [
      'root = Col([Text("一条消息从输入框到屏幕", "title"), Flow(steps, $step), Progress("进度", ($step + 1) / @Len(steps) * 100)])',
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
  'Hard rules: inline everything (no network); colors only via var(--viz-*) theme variables, never on :root/html/body; layouts must read in a 380–700px wide card (no fixed widths); write <style> first, the visible <body> next and every <script> last. Each call publishes its own card, so finish the page before calling; once it is shown, do not restate its contents in text.'

export const PRESENT_VISUALIZATION_DESCRIPTION = `Show the user an interactive visual — phased flow walkthrough, architecture map, comparison, simulator or chart — rendered inline in the chat from one self-contained HTML document.

When to use it, the archetypes, layout, sandbox and theme rules and the built-in classes are in your instructions under 可视化讲解 and 可视化写法.
${HARD_RULES}`

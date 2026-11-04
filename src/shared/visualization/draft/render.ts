import { DRAFT_LIMITS } from './limits'
import { issue, stableIssues } from './parser'
import type { DraftBlock, DraftPanel, VisualizationDraftIssue } from './types'
import { isTableDivider, splitCells } from './tableSyntax'

interface RenderedPanels {
  readonly html: string
  readonly issues: readonly VisualizationDraftIssue[]
  readonly interactive: boolean
}

interface ComponentContext {
  readonly id: string
  readonly issues: VisualizationDraftIssue[]
}

export function renderVisualizationPanels(panels: readonly DraftPanel[]): RenderedPanels {
  const issues: VisualizationDraftIssue[] = []
  let interactive = false
  const html = panels.map((panel, panelIndex) => {
    const blocks = panel.blocks.map((block, blockIndex) => {
      const rendered = renderBlock(block, `p${panelIndex + 1}b${blockIndex + 1}`, issues)
      if (block.type === 'component' && ['flow', 'ask', 'remark', 'comparison'].includes(block.kind)) interactive = true
      return rendered
    }).join('')
    return `<section class="viz-draft-panel" data-source-line="${panel.line}"><h2 class="viz-draft-panel__title">${text(panel.title)}</h2>${blocks}</section>`
  }).join('')
  return { html, issues: stableIssues(issues), interactive }
}

function renderBlock(block: DraftBlock, id: string, issues: VisualizationDraftIssue[]): string {
  if (block.type === 'paragraph') return `<p class="viz-draft-text" data-source-line="${block.line}">${text(block.text)}</p>`
  if (block.type === 'list') {
    const tag = block.ordered ? 'ol' : 'ul'
    return `<${tag} class="viz-draft-list" data-source-line="${block.line}">${block.items.map(item => `<li>${text(item)}</li>`).join('')}</${tag}>`
  }
  const context = { id, issues }
  switch (block.kind) {
    case 'flow': return renderFlow(block, context)
    case 'sequence': return renderSequence(block, context)
    case 'tree': return renderTree(block, context)
    case 'timeline': return renderTimeline(block, context)
    case 'comparison': return renderComparison(block, context)
    case 'kv': return renderKv(block, context)
    case 'callout': return renderCallout(block, context)
    case 'code': return renderCode(block, context)
    case 'chart': return renderChart(block, context)
    case 'ask': return renderAsk(block, context)
    case 'remark': return renderRemark(block, context)
    default:
      issues.push(issue(block.line, 1, 'unknown-component', `未知组件 ${block.kind}。`, '```kv\n重点 | 内容\n```'))
      return ''
  }
}

function attributes(block: Extract<DraftBlock, { type: 'component' }>, allowed: readonly string[], issues: VisualizationDraftIssue[]): Map<string, string> {
  const allowedNames = new Set(allowed)
  const result = new Map<string, string>()
  for (const attribute of block.attributes) {
    if (!allowedNames.has(attribute.name)) {
      issues.push(issue(block.line, attribute.column, 'unknown-attribute', `${block.kind} 不支持属性 ${attribute.name}。`, null))
      continue
    }
    result.set(attribute.name, attribute.value)
  }
  return result
}

function lines(block: Extract<DraftBlock, { type: 'component' }>): Array<{ text: string; line: number }> {
  return block.body.split('\n').map((value, index) => ({ text: value, line: block.bodyLine + index })).filter(item => item.text.trim())
}

function renderFlow(block: Extract<DraftBlock, { type: 'component' }>, context: ComponentContext): string {
  const attrs = attributes(block, ['direction', 'selected'], context.issues)
  const direction = attrs.get('direction') ?? 'col'
  if (direction !== 'col' && direction !== 'row') {
    context.issues.push(issue(block.line, null, 'invalid-flow-direction', 'direction 只能是 col 或 row。', '```flow direction=col'))
  }
  const selected = attrs.get('selected')
  const edges: Array<{ from: string; to: string; label: string; line: number }> = []
  const nodes: string[] = []
  const nodeSet = new Set<string>()
  const groups: Array<{ name: string; nodes: string[] }> = []
  let currentGroup: { name: string; nodes: string[] } | null = null
  const addNode = (node: string, line: number, inGroup = false): void => {
    if (!nodeSet.has(node)) {
      nodeSet.add(node)
      nodes.push(node)
    }
    if (inGroup && currentGroup && !currentGroup.nodes.includes(node)) currentGroup.nodes.push(node)
    if (Array.from(node).length > 80) context.issues.push(issue(line, null, 'flow-node-too-long', '节点名最多 80 字符。', null))
  }
  for (const item of lines(block)) {
    const group = /^@group\s+(.+)$/.exec(item.text)
    if (group) {
      currentGroup = { name: group[1].trim(), nodes: [] }
      groups.push(currentGroup)
      continue
    }
    const match = /^(.+?)\s*->\s*(.+?)(?::\s*(.+))?$/.exec(item.text)
    if (!match) {
      if (currentGroup && item.text.trim()) {
        addNode(item.text.trim(), item.line, true)
      } else {
        context.issues.push(issue(item.line, null, 'invalid-flow-edge', '每行写 起点 -> 终点: 可选说明；分组用 @group 后逐行写节点。', '@group 入口层\nCLI\nPreload\nCLI -> Preload: 提问'))
      }
      continue
    }
    const from = match[1].trim()
    const to = match[2].trim()
    if (!from || !to) {
      context.issues.push(issue(item.line, null, 'flow-node-required', '起点和终点不能为空。', 'A -> B: 说明'))
      continue
    }
    addNode(from, item.line)
    addNode(to, item.line)
    edges.push({ from, to, label: match[3]?.trim() ?? '', line: item.line })
  }
  if (!edges.length) context.issues.push(issue(block.bodyLine, null, 'flow-empty', 'flow 至少需要一个有向边。', 'A -> B: 调用'))
  if (nodes.length > DRAFT_LIMITS.nodes) context.issues.push(issue(block.bodyLine, null, 'too-many-nodes', `最多 ${DRAFT_LIMITS.nodes} 个节点。`, null))
  if (!groups.length && nodes.length > DRAFT_LIMITS.flatFlowNodes) {
    context.issues.push(issue(
      block.line,
      1,
      'flat-flow-too-many-nodes',
      `未分组 flow 最多 ${DRAFT_LIMITS.flatFlowNodes} 个节点；请拆成多个 flow 或用 @group 按阶段分组。`,
      '```flow direction=col\n输入 -> 校验: 第一步\n校验 -> 执行: 第二步\n```\n\n```flow direction=col\n执行 -> 输出: 最后一步\n```'
    ))
  }
  if (edges.length > DRAFT_LIMITS.edges) context.issues.push(issue(block.bodyLine, null, 'too-many-edges', `最多 ${DRAFT_LIMITS.edges} 条边。`, null))
  if (selected && !nodeSet.has(selected)) context.issues.push(issue(block.line, null, 'unknown-selected-node', 'selected 必须是一个已声明节点。', null))

  const nodeHtml = (node: string): string => {
    const index = nodes.indexOf(node)
    return `<button type="button" class="viz-node viz-draft-flow__node" data-viz-select="${attr(node)}" data-active="${node === selected ? 'true' : 'false'}" aria-pressed="${node === selected ? 'true' : 'false'}"><span class="viz-node-step">${index + 1}</span><span>${text(node)}</span></button>`
  }
  const groupedNodes = groups.map(group => `<div class="viz-lane"><span class="viz-lane-label">${text(group.name)}</span><div class="viz-lane-nodes">${group.nodes.map(nodeHtml).join('')}</div></div>`).join('')
  const groupedSet = new Set(groups.flatMap(group => group.nodes))
  const ungrouped = nodes.filter(node => !groupedSet.has(node))
  const nodeSection = groups.length
    ? `<div class="viz-lanes">${groupedNodes}${ungrouped.length ? `<div class="viz-lane"><span class="viz-lane-label">其他节点</span><div class="viz-lane-nodes">${ungrouped.map(nodeHtml).join('')}</div></div>` : ''}</div>`
    : `<div class="viz-draft-flow__nodes">${nodes.map(nodeHtml).join('')}</div>`
  const edgeHtml = edges.map(edge => `<li data-source-line="${edge.line}"><span>${text(edge.from)}</span><span class="viz-draft-arrow" aria-hidden="true">→</span><span>${text(edge.to)}</span>${edge.label ? `<small>${text(edge.label)}</small>` : ''}</li>`).join('')
  return `<div class="viz-draft-flow" data-direction="${direction}" data-source-line="${block.line}">${nodeSection}<ol class="viz-draft-flow__edges">${edgeHtml}</ol></div>`
}

function renderSequence(block: Extract<DraftBlock, { type: 'component' }>, context: ComponentContext): string {
  attributes(block, [], context.issues)
  const messages: Array<{ from: string; to: string; arrow: string; kind: string; label: string; line: number }> = []
  for (const item of lines(block)) {
    const match = /^(.+?)\s*(-->|->>|->)\s*(.+?)(?::\s*(.+))?$/.exec(item.text)
    if (!match) {
      context.issues.push(issue(item.line, null, 'invalid-sequence-message', '每行写 发送者 -> 接收者: 消息；--> 表示返回，->> 表示异步。', 'Agent -> Model: messages'))
      continue
    }
    const arrow = match[2] === '-->' ? '↩' : match[2] === '->>' ? '⇢' : '→'
    const kind = match[2] === '-->' ? 'return' : match[2] === '->>' ? 'async' : 'sync'
    messages.push({ from: match[1].trim(), to: match[3].trim(), arrow, kind, label: match[4]?.trim() ?? '', line: item.line })
  }
  if (!messages.length) context.issues.push(issue(block.bodyLine, null, 'sequence-empty', 'sequence 至少需要一条消息。', 'A -> B: 请求'))
  if (messages.length > DRAFT_LIMITS.edges) context.issues.push(issue(block.bodyLine, null, 'too-many-messages', `最多 ${DRAFT_LIMITS.edges} 条消息。`, null))
  const participants = new Set(messages.flatMap(message => [message.from, message.to]))
  if (participants.size > DRAFT_LIMITS.nodes) context.issues.push(issue(block.bodyLine, null, 'too-many-participants', `最多 ${DRAFT_LIMITS.nodes} 个参与者。`, null))
  return `<ol class="viz-draft-sequence" data-source-line="${block.line}">${messages.map((message, index) => `<li data-source-line="${message.line}"><span class="viz-draft-sequence__index">${index + 1}</span><div class="viz-draft-sequence__route"><strong>${text(message.from)}</strong><span class="viz-draft-arrow" data-kind="${message.kind}" aria-hidden="true">${message.arrow}</span><strong>${text(message.to)}</strong></div><p>${text(message.label)}</p></li>`).join('')}</ol>`
}

interface TreeNode {
  readonly label: string
  readonly line: number
  readonly children: TreeNode[]
}

function renderTree(block: Extract<DraftBlock, { type: 'component' }>, context: ComponentContext): string {
  attributes(block, [], context.issues)
  const roots: TreeNode[] = []
  const stack: Array<{ depth: number; node: TreeNode }> = []
  let previousDepth = 0
  let count = 0
  for (const item of block.body.split('\n').map((textValue, index) => ({ text: textValue, line: block.bodyLine + index }))) {
    if (!item.text.trim()) continue
    if (item.text.includes('\t')) {
      context.issues.push(issue(item.line, null, 'tree-tab-indent', 'tree 缩进只使用空格，每层两个空格。', '根节点\n  子节点'))
      continue
    }
    const spaces = item.text.length - item.text.trimStart().length
    if (spaces % 2 !== 0) {
      context.issues.push(issue(item.line, 1, 'tree-indent', 'tree 每层缩进两个空格。', '根节点\n  子节点'))
      continue
    }
    const depth = spaces / 2
    if (depth > previousDepth + 1) {
      context.issues.push(issue(item.line, 1, 'tree-depth-jump', '不能跳过中间层级。', '根节点\n  子节点'))
      continue
    }
    if (depth >= DRAFT_LIMITS.treeDepth) {
      context.issues.push(issue(item.line, 1, 'tree-too-deep', `最多 ${DRAFT_LIMITS.treeDepth} 层。`, null))
      continue
    }
    const node: TreeNode = { label: item.text.trim(), line: item.line, children: [] }
    count += 1
    if (depth === 0) roots.push(node)
    else stack[depth - 1]?.node.children.push(node)
    stack[depth] = { depth, node }
    stack.length = depth + 1
    previousDepth = depth
  }
  if (!roots.length) context.issues.push(issue(block.bodyLine, null, 'tree-empty', 'tree 至少需要一个根节点。', '根节点\n  子节点'))
  if (count > DRAFT_LIMITS.nodes) context.issues.push(issue(block.bodyLine, null, 'too-many-nodes', `最多 ${DRAFT_LIMITS.nodes} 个节点。`, null))
  const renderNodes = (nodes: readonly TreeNode[]): string => `<ul>${nodes.map(node => `<li data-source-line="${node.line}"><span>${text(node.label)}</span>${node.children.length ? renderNodes(node.children) : ''}</li>`).join('')}</ul>`
  return `<div class="viz-draft-tree" data-source-line="${block.line}">${renderNodes(roots)}</div>`
}

function renderTimeline(block: Extract<DraftBlock, { type: 'component' }>, context: ComponentContext): string {
  const attrs = attributes(block, ['current'], context.issues)
  const current = attrs.get('current')
  const entries = lines(block).map(item => {
    const cells = splitCells(item.text)
    if (cells.length < 2 || cells.length > 3) {
      context.issues.push(issue(item.line, null, 'invalid-timeline-entry', '每行写 时间 | 事件 | 可选说明。', '第 1 步 | 接收输入 | 校验参数'))
      return null
    }
    return { cells, line: item.line }
  }).filter((entry): entry is { cells: string[]; line: number } => entry !== null)
  if (!entries.length) context.issues.push(issue(block.bodyLine, null, 'timeline-empty', 'timeline 至少需要一个事件。', '开始 | 接收请求'))
  if (entries.length > DRAFT_LIMITS.tableRows) context.issues.push(issue(block.bodyLine, null, 'too-many-events', `最多 ${DRAFT_LIMITS.tableRows} 个事件。`, null))
  if (current && !entries.some(entry => entry.cells[0] === current)) context.issues.push(issue(block.line, null, 'unknown-current-event', 'current 必须匹配一个时间或阶段。', null))
  return `<ol class="viz-draft-timeline" data-source-line="${block.line}">${entries.map(entry => `<li data-current="${entry.cells[0] === current ? 'true' : 'false'}" data-source-line="${entry.line}"><span class="viz-draft-timeline__time">${text(entry.cells[0])}</span><div><strong>${text(entry.cells[1])}</strong>${entry.cells[2] ? `<p>${text(entry.cells[2])}</p>` : ''}</div></li>`).join('')}</ol>`
}

function renderComparison(block: Extract<DraftBlock, { type: 'component' }>, context: ComponentContext): string {
  const attrs = attributes(block, ['views'], context.issues)
  const sections: Array<Array<{ cells: string[]; line: number }>> = [[]]
  for (const item of lines(block)) {
    if (item.text.trim() === '---') {
      sections.push([])
      continue
    }
    const cells = splitCells(item.text)
    if (isTableDivider(cells)) continue
    sections.at(-1)!.push({ cells, line: item.line })
  }
  const viewNames = attrs.get('views')?.split(/[,，]/).map(value => value.trim()).filter(Boolean) ?? []
  if (viewNames.some(name => !['Before', 'After', 'Changes'].includes(name)) || new Set(viewNames).size !== viewNames.length) {
    context.issues.push(issue(block.line, null, 'invalid-comparison-views', 'views 只能组合 Before,After,Changes，且不能重复。', '```comparison views=Before,After,Changes'))
  }
  if (viewNames.length && (viewNames.length !== sections.length || new Set(viewNames).size !== viewNames.length)) {
    context.issues.push(issue(block.line, null, 'comparison-view-count', '每个视图用 --- 分隔，视图数量需一致。', 'Before 表\n---\nAfter 表'))
  }
  if (!viewNames.length && sections.length > 1) context.issues.push(issue(block.line, null, 'comparison-views-required', '多表比较需声明 views=Before,After,Changes。', null))

  const tables = sections.map((rows, sectionIndex) => {
    const headers = rows[0]?.cells ?? []
    const firstLine = rows[0]?.line ?? block.bodyLine
    if (headers.length < 2 || headers.length > DRAFT_LIMITS.tableColumns) {
      context.issues.push(issue(firstLine, null, 'comparison-columns', `comparison 需要 2–${DRAFT_LIMITS.tableColumns} 列。`, '维度 | 方案 A | 方案 B'))
    }
    if (rows.length < 2) context.issues.push(issue(firstLine, null, 'comparison-empty', 'comparison 需要表头和至少一行数据。', '维度 | A | B\n成本 | 低 | 高'))
    if (rows.length - 1 > DRAFT_LIMITS.tableRows) context.issues.push(issue(firstLine, null, 'too-many-rows', `最多 ${DRAFT_LIMITS.tableRows} 行数据。`, null))
    for (const row of rows.slice(1)) {
      if (row.cells.length !== headers.length) context.issues.push(issue(row.line, null, 'comparison-row-width', `此行应有 ${headers.length} 列。`, null))
    }
    const table = `<div class="viz-draft-table-wrap"><table class="viz-table viz-draft-table"><thead><tr>${headers.map(header => `<th scope="col">${text(header)}</th>`).join('')}</tr></thead><tbody>${rows.slice(1).map(row => `<tr data-source-line="${row.line}">${row.cells.map((cell, index) => `<td data-label="${attr(headers[index] ?? '')}">${text(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
    if (!viewNames.length) return table
    const panelId = `${context.id}-view-${sectionIndex}`
    return `<div id="${panelId}" role="tabpanel" aria-labelledby="${panelId}-tab" data-viz-view-panel="${sectionIndex}"${sectionIndex === 0 ? '' : ' hidden'}>${table}</div>`
  }).join('')
  if (!viewNames.length) return `<div class="viz-draft-table-wrap" data-source-line="${block.line}">${tables}</div>`
  const tabs = viewNames.map((name, index) => `<button id="${context.id}-view-${index}-tab" type="button" role="tab" class="viz-phase${index === 0 ? ' is-active' : ''}" aria-selected="${index === 0 ? 'true' : 'false'}" aria-controls="${context.id}-view-${index}" data-viz-view="${index}">${text(name)}</button>`).join('')
  return `<div class="viz-draft-views" data-source-line="${block.line}"><div class="viz-phases" role="tablist" aria-label="比较视图">${tabs}</div>${tables}</div>`
}

function renderKv(block: Extract<DraftBlock, { type: 'component' }>, context: ComponentContext): string {
  attributes(block, [], context.issues)
  const entries = lines(block).map(item => {
    const separator = item.text.indexOf('|')
    if (separator <= 0) {
      context.issues.push(issue(item.line, null, 'invalid-kv', '每行写 名称 | 内容。', '唯一写入者 | SessionStore'))
      return null
    }
    return { key: item.text.slice(0, separator).trim(), value: item.text.slice(separator + 1).trim(), line: item.line }
  }).filter((entry): entry is { key: string; value: string; line: number } => entry !== null)
  if (!entries.length) context.issues.push(issue(block.bodyLine, null, 'kv-empty', 'kv 至少需要一个事实。', '重点 | 内容'))
  if (entries.length > DRAFT_LIMITS.tableRows) context.issues.push(issue(block.bodyLine, null, 'too-many-facts', `最多 ${DRAFT_LIMITS.tableRows} 个事实。`, null))
  return `<dl class="viz-kv viz-draft-kv" data-source-line="${block.line}">${entries.map(entry => `<dt data-source-line="${entry.line}">${text(entry.key)}</dt><dd>${text(entry.value)}</dd>`).join('')}</dl>`
}

function renderCallout(block: Extract<DraftBlock, { type: 'component' }>, context: ComponentContext): string {
  const attrs = attributes(block, ['tone', 'title'], context.issues)
  const tone = attrs.get('tone') ?? 'info'
  if (!['neutral', 'info', 'success', 'warning', 'danger'].includes(tone)) {
    context.issues.push(issue(block.line, null, 'invalid-callout-tone', 'tone 只能是 neutral/info/success/warning/danger。', '```callout tone=info'))
  }
  if (!block.body.trim()) context.issues.push(issue(block.bodyLine, null, 'callout-empty', 'callout 需要正文。', '```callout\n纯文本说明\n```'))
  const paragraphs = block.body.split(/\n\s*\n/).map(part => part.split('\n').map(line => line.trim()).filter(Boolean).join(' ')).filter(Boolean)
  return `<aside class="viz-draft-callout" data-tone="${tone}" data-source-line="${block.line}">${attrs.get('title') ? `<strong>${text(attrs.get('title')!)}</strong>` : ''}${paragraphs.map(paragraph => `<p>${text(paragraph)}</p>`).join('')}</aside>`
}

function renderCode(block: Extract<DraftBlock, { type: 'component' }>, context: ComponentContext): string {
  const attrs = attributes(block, ['lang', 'file'], context.issues)
  const lang = attrs.get('lang') ?? 'text'
  if (!/^[a-z0-9+#-]{1,24}$/i.test(lang)) context.issues.push(issue(block.line, null, 'invalid-code-language', 'lang 只能包含字母、数字、+、#、-。', '```code lang=ts'))
  const file = attrs.get('file')
  const codeLines = block.body ? block.body.split('\n') : []
  if (!codeLines.length) context.issues.push(issue(block.bodyLine, null, 'code-empty', 'code 需要至少一行代码。', '```code lang=ts\nconst value = 1\n```'))
  if (codeLines.length > DRAFT_LIMITS.codeLines) context.issues.push(issue(block.bodyLine, null, 'code-too-long', `代码最多 ${DRAFT_LIMITS.codeLines} 行。`, null))
  return `<figure class="viz-draft-code" data-source-line="${block.line}">${file ? `<figcaption><span class="viz-file-ref">${text(file)}</span><span>${text(lang)}</span></figcaption>` : ''}<pre class="viz-code"><code data-lang="${attr(lang)}">${text(block.body)}</code></pre></figure>`
}

interface ChartData {
  readonly labels: readonly string[]
  readonly series: ReadonlyArray<{ name: string; values: number[] }>
}

function renderChart(block: Extract<DraftBlock, { type: 'component' }>, context: ComponentContext): string {
  const attrs = attributes(block, ['type', 'unit'], context.issues)
  const type = attrs.get('type') ?? 'bar'
  if (!['bar', 'line', 'area'].includes(type)) context.issues.push(issue(block.line, null, 'invalid-chart-type', 'type 只能是 bar、line 或 area。', '```chart type=bar'))
  const unit = attrs.get('unit') ?? ''
  const rows = lines(block).map(item => ({ cells: splitCells(item.text), line: item.line }))
  const headers = rows[0]?.cells ?? []
  if (headers.length < 2 || headers.length > DRAFT_LIMITS.chartSeries + 1) {
    context.issues.push(issue(block.bodyLine, null, 'chart-series', `chart 需要 1–${DRAFT_LIMITS.chartSeries} 个系列。`, '项目 | 数值\n示例 | 1'))
  }
  const dataRows = rows.slice(1)
  if (!dataRows.length) context.issues.push(issue(block.bodyLine, null, 'chart-empty', 'chart 至少需要一个数据点。', '项目 | 数值\n示例 | 1'))
  if (dataRows.length > DRAFT_LIMITS.chartPoints) context.issues.push(issue(block.bodyLine, null, 'too-many-points', `最多 ${DRAFT_LIMITS.chartPoints} 个数据点。`, null))
  const values: number[][] = []
  for (const row of dataRows) {
    if (row.cells.length !== headers.length) {
      context.issues.push(issue(row.line, null, 'chart-row-width', `此行应有 ${headers.length} 列。`, null))
      continue
    }
    const numeric = row.cells.slice(1).map(value => Number(value))
    numeric.forEach((value, index) => {
      if (!Number.isFinite(value) || Math.abs(value) > 1_000_000_000) context.issues.push(issue(row.line, null, 'invalid-chart-value', `${headers[index + 1] ?? '系列'} 必须是有限数值。`, '延迟 | 38'))
    })
    values.push(numeric)
    if (Array.from(row.cells[0]).length > DRAFT_LIMITS.chartLabelChars) context.issues.push(issue(row.line, null, 'chart-label-too-long', `标签最多 ${DRAFT_LIMITS.chartLabelChars} 字符。`, null))
  }
  const series = headers.slice(1).map((name, seriesIndex) => ({ name, values: values.map(row => row[seriesIndex]).filter((value): value is number => value !== undefined && Number.isFinite(value)) }))
  const data: ChartData = { labels: dataRows.map(row => row.cells[0] ?? ''), series }
  const validValues = series.flatMap(item => item.values).filter(Number.isFinite)
  if (!validValues.length) return '<figure class="viz-draft-chart"></figure>'
  const minimum = Math.min(0, ...validValues)
  const maximum = Math.max(0, ...validValues)
  const range = maximum - minimum || 1
  const y = (value: number): number => 200 - ((value - minimum) / range) * 160
  const zeroY = y(0)
  const count = Math.max(1, data.labels.length)
  const x = (index: number): number => 16 + (count === 1 ? 36 : (index / (count - 1)) * 72)
  const grid = [0, 0.25, 0.5, 0.75, 1].map(ratio => {
    const value = minimum + range * (1 - ratio)
    const gridY = 20 + ratio * 180
    return `<line x1="14%" x2="92%" y1="${gridY}" y2="${gridY}" stroke="var(--viz-border)"/><text x="1" y="${gridY + 4}" font-size="12" fill="var(--viz-muted)">${text(formatNumber(value))}</text>`
  }).join('')
  const seriesHtml = series.map((item, seriesIndex) => {
    const colorClass = `viz-s${seriesIndex + 1}`
    if (type === 'bar') {
      const groupWidth = 76 / count
      const barWidth = Math.max(0.8, groupWidth / series.length - 1)
      return item.values.map((value, pointIndex) => {
        const barX = 14 + pointIndex * groupWidth + seriesIndex * (groupWidth / series.length) + 0.5
        const valueY = y(value)
        return `<rect class="${colorClass}" x="${barX}%" width="${barWidth}%" y="${Math.min(valueY, zeroY)}" height="${Math.abs(valueY - zeroY)}" rx="2"><title>${text(`${data.labels[pointIndex] ?? ''} · ${item.name}: ${formatNumber(value)}${unit}`)}</title></rect>`
      }).join('')
    }
    const segments = item.values.slice(1).map((value, pointIndex) => {
      const previous = item.values[pointIndex]
      return `<line class="${colorClass}" x1="${x(pointIndex)}%" x2="${x(pointIndex + 1)}%" y1="${y(previous)}" y2="${y(value)}" stroke="currentColor" stroke-width="2.5"/>`
    }).join('')
    const area = type === 'area' ? item.values.map((value, pointIndex) => `<rect class="${colorClass}" x="${x(pointIndex) - 2}%" width="4%" y="${Math.min(y(value), zeroY)}" height="${Math.abs(y(value) - zeroY)}" opacity="0.1"/>`).join('') : ''
    const points = item.values.map((value, pointIndex) => `<circle class="${colorClass}" cx="${x(pointIndex)}%" cy="${y(value)}" r="4"><title>${text(`${data.labels[pointIndex] ?? ''} · ${item.name}: ${formatNumber(value)}${unit}`)}</title></circle>`).join('')
    return `${area}${segments}${points}`
  }).join('')
  const labelStep = Math.max(1, Math.ceil(count / 6))
  const labels = data.labels.map((label, index) => index % labelStep === 0 || index === count - 1 ? `<text x="${x(index)}%" y="226" text-anchor="middle" font-size="12" fill="var(--viz-muted)">${text(label)}</text>` : '').join('')
  const legend = series.map((item, index) => `<span><i class="viz-s${index + 1}"></i>${text(item.name)}${unit ? `（${text(unit)}）` : ''}</span>`).join('')
  const table = `<details class="viz-draft-chart__data"><summary>查看数据</summary><table class="viz-table"><thead><tr>${headers.map(header => `<th>${text(header)}</th>`).join('')}</tr></thead><tbody>${dataRows.map(row => `<tr>${row.cells.map((cell, index) => `<td data-label="${attr(headers[index] ?? '')}">${text(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></details>`
  return `<figure class="viz-draft-chart" data-source-line="${block.line}"><figcaption>${legend}</figcaption><svg width="100%" height="244" role="img" aria-label="${attr(`${type} 图表，共 ${count} 个数据点`)}">${grid}<line x1="14%" x2="92%" y1="${zeroY}" y2="${zeroY}" stroke="var(--viz-muted)"/>${seriesHtml}${labels}</svg>${table}</figure>`
}

function renderAsk(block: Extract<DraftBlock, { type: 'component' }>, context: ComponentContext): string {
  const attrs = attributes(block, ['id'], context.issues)
  const id = attrs.get('id') ?? context.id
  validateId(id, block.line, context.issues)
  const items = lines(block)
  const question = items[0]?.text.trim() ?? ''
  if (!question) context.issues.push(issue(block.bodyLine, null, 'ask-question-required', 'ask 第一行需要明确问题。', '```ask\n默认结论已经看懂了吗？\n看懂 | 继续\n```'))
  const options = items.slice(1).map(item => {
    const cells = splitCells(item.text)
    if (cells.length < 1 || cells.length > 2 || !cells[0]) {
      context.issues.push(issue(item.line, null, 'invalid-ask-option', '每行写 选项 | 可选追问。', '看懂 | 已看懂，请继续'))
      return null
    }
    return { label: cells[0], prompt: cells[1] || `请继续讲解：${cells[0]}`, line: item.line }
  }).filter((option): option is { label: string; prompt: string; line: number } => option !== null)
  if (!options.length) context.issues.push(issue(block.bodyLine, null, 'ask-options-required', 'ask 至少需要一个选项。', '看懂 | 已看懂，请继续'))
  if (options.length > DRAFT_LIMITS.askOptions) context.issues.push(issue(block.bodyLine, null, 'too-many-options', `最多 ${DRAFT_LIMITS.askOptions} 个选项。`, null))
  return `<div class="viz-draft-ask" data-viz-block="${attr(id)}" data-source-line="${block.line}"><p>${text(question)}</p><div class="viz-row">${options.map((option, index) => `<button type="button" class="viz-btn${index === 0 ? ' viz-btn-primary' : ''}" data-viz-ask data-label="${attr(option.label)}" data-prompt="${attr(option.prompt)}" data-source-line="${option.line}">${text(option.label)}</button>`).join('')}</div></div>`
}

function renderRemark(block: Extract<DraftBlock, { type: 'component' }>, context: ComponentContext): string {
  const attrs = attributes(block, ['id', 'title'], context.issues)
  const id = attrs.get('id') ?? context.id
  validateId(id, block.line, context.issues)
  const title = attrs.get('title') ?? '补充你的理解或疑问'
  return `<div class="viz-draft-remark" data-viz-block="${attr(id)}" data-source-line="${block.line}"><label for="${attr(context.id)}-remark">${text(title)}</label><textarea id="${attr(context.id)}-remark" data-viz-remark-input rows="3" maxlength="1000" placeholder="只作为本次学习的补充资料"></textarea><div class="viz-row"><button type="button" class="viz-btn" data-viz-remark>发送补充</button></div></div>`
}

function validateId(id: string, line: number, issues: VisualizationDraftIssue[]): void {
  if (!/^[A-Za-z][\w-]{0,63}$/.test(id)) issues.push(issue(line, null, 'invalid-block-id', 'id 需以字母开头，只含字母、数字、_、-，最多 64 字符。', '```ask id=confirm-owner'))
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value)
  return value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
}

export function text(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function attr(value: string): string {
  return text(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

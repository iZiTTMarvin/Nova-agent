import { DRAFT_LIMITS } from './limits'
import type { DraftAttribute, DraftBlock, DraftPanel, DraftParseResult, VisualizationDraftIssue } from './types'
import { startsMarkdownTable } from './tableSyntax'

const COMPONENT_START = /^```([A-Za-z][\w-]*)(?:\s+([\s\S]*))?$/
const RAW_HTML = /<\/?[A-Za-z][^>]*>/
const LIST_ITEM = /^\s*(?:([-+])|(\d+)[.)])\s+([\s\S]+)$/

export function parseVisualizationDraft(source: string): DraftParseResult {
  const issues: VisualizationDraftIssue[] = []
  if (source.length > DRAFT_LIMITS.sourceChars) {
    return { panels: [], issues: [issue(1, null, 'draft-too-large', `草稿最多 ${DRAFT_LIMITS.sourceChars} 字符。`, null)] }
  }
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const panels: DraftPanel[] = []
  let current: { line: number; title: string; blocks: DraftBlock[]; terminated: boolean } | null = null
  let index = 0

  while (index < lines.length) {
    const lineNumber = index + 1
    const line = lines[index]
    const heading = /^##(?:\s+([\s\S]*?))?\s*$/.exec(line)
    if (heading) {
      if (current) current.terminated = true
      const title = heading[1] ?? ''
      current = { line: lineNumber, title, blocks: [], terminated: false }
      panels.push(current)
      if (!title.trim()) issues.push(issue(lineNumber, 1, 'panel-title-required', '面板标题不能为空。', '## 请求链路'))
      if (Array.from(title).length > DRAFT_LIMITS.panelTitleChars) {
        issues.push(issue(lineNumber, 4, 'panel-title-too-long', `面板标题最多 ${DRAFT_LIMITS.panelTitleChars} 字符。`, null))
      }
      if (panels.length > DRAFT_LIMITS.panels) {
        issues.push(issue(lineNumber, 1, 'too-many-panels', `最多 ${DRAFT_LIMITS.panels} 个面板。`, null))
      }
      index += 1
      continue
    }

    const fence = COMPONENT_START.exec(line)
    if (fence) {
      if (!current) {
        issues.push(issue(lineNumber, 1, 'panel-required', '组件必须放在 ## 面板内。', '## 讲解\n\n```kv\n重点 | 内容\n```'))
      }
      const attributes = parseAttributes(fence[2] ?? '', lineNumber, fence[1].length + 4, issues)
      const bodyLine = lineNumber + 1
      const body: string[] = []
      index += 1
      let closed = false
      while (index < lines.length) {
        if (lines[index].trim() === '```') {
          closed = true
          break
        }
        body.push(lines[index])
        index += 1
      }
      if (body.length > DRAFT_LIMITS.componentLines) {
        issues.push(issue(bodyLine, null, 'component-too-many-lines', `单个组件最多 ${DRAFT_LIMITS.componentLines} 行。`, null))
      }
      const block: DraftBlock = {
        type: 'component', line: lineNumber, bodyLine, kind: fence[1], attributes, body: body.join('\n')
      }
      current?.blocks.push(block)
      if (!closed) {
        issues.push(issue(lineNumber, 1, 'unclosed-fence', '代码围栏尚未闭合。', '```kv\n重点 | 内容\n```'))
        break
      }
      index += 1
      continue
    }

    if (line.trim().startsWith('```')) {
      issues.push(issue(lineNumber, 1, 'invalid-fence', '围栏需写明组件名，例如 ```kv。', '```kv\n重点 | 内容\n```'))
      index += 1
      continue
    }
    if (!current) {
      if (line.trim()) issues.push(issue(lineNumber, 1, 'panel-required', '正文必须放在 ## 面板内。', '## 核心结论\n\n正文内容。'))
      index += 1
      continue
    }
    if (!line.trim()) {
      index += 1
      continue
    }
    if (startsMarkdownTable(lines, index)) {
      const body = [lines[index], lines[index + 1]]
      index += 2
      while (index < lines.length && lines[index].trim().startsWith('|')) {
        body.push(lines[index])
        index += 1
      }
      current.blocks.push({ type: 'component', kind: 'comparison', line: lineNumber, bodyLine: lineNumber, attributes: [], body: body.join('\n') })
      continue
    }
    if (RAW_HTML.test(line.replace(/`[^`\r\n]*`/g, ''))) {
      issues.push(issue(lineNumber, null, 'raw-html-forbidden', '不允许原始 HTML；请使用正文或声明式组件。', '```callout tone=info\n纯文本内容\n```'))
    }
    if (Array.from(line).length > DRAFT_LIMITS.textChars) {
      issues.push(issue(lineNumber, null, 'text-too-long', `单行文本最多 ${DRAFT_LIMITS.textChars} 字符。`, null))
    }

    const listMatch = LIST_ITEM.exec(line)
    if (listMatch) {
      const ordered = listMatch[2] !== undefined
      const items: string[] = []
      while (index < lines.length) {
        const match = LIST_ITEM.exec(lines[index])
        if (!match || (match[2] !== undefined) !== ordered) break
        items.push(match[3].trim())
        index += 1
      }
      current.blocks.push({ type: 'list', line: lineNumber, ordered, items })
      continue
    }

    const paragraph: string[] = []
    while (index < lines.length && lines[index].trim() && !/^##\s+/.test(lines[index]) && !lines[index].trim().startsWith('```') && !LIST_ITEM.test(lines[index]) && !startsMarkdownTable(lines, index)) {
      paragraph.push(lines[index].trim())
      index += 1
    }
    current.blocks.push({ type: 'paragraph', line: lineNumber, text: paragraph.join(' ') })
  }

  return { panels, issues: stableIssues(issues) }
}

function parseAttributes(source: string, line: number, offset: number, issues: VisualizationDraftIssue[]): DraftAttribute[] {
  const attributes: DraftAttribute[] = []
  const seen = new Set<string>()
  let index = 0
  while (index < source.length) {
    while (/\s/.test(source[index] ?? '')) index += 1
    if (index >= source.length) break
    const start = index
    const key = /^[a-z][a-z0-9-]*/.exec(source.slice(index))?.[0]
    if (!key) {
      issues.push(issue(line, offset + start + 1, 'invalid-attribute', '属性需写成 name=value。', '```flow direction=col'))
      break
    }
    index += key.length
    if (source[index] !== '=') {
      issues.push(issue(line, offset + start + 1, 'invalid-attribute', `属性 ${key} 缺少 =。`, `${key}=value`))
      break
    }
    index += 1
    let value = ''
    const quote = source[index] === '"' || source[index] === "'" ? source[index] : null
    if (quote) {
      index += 1
      const valueStart = index
      while (index < source.length && source[index] !== quote) index += 1
      if (index >= source.length) {
        issues.push(issue(line, offset + start + 1, 'unclosed-attribute', `属性 ${key} 的引号未闭合。`, `${key}="value"`))
        break
      }
      value = source.slice(valueStart, index)
      index += 1
      if (index < source.length && !/\s/.test(source[index])) {
        issues.push(issue(line, offset + index + 1, 'invalid-attribute', `属性 ${key} 后需要空格。`, null))
      }
    } else {
      const valueStart = index
      while (index < source.length) {
        const rest = source.slice(index)
        if (/\s/.test(source[index]) && /^\s+[a-z][a-z0-9-]*=/.test(rest)) break
        index += 1
      }
      value = source.slice(valueStart, index).trim()
    }
    if (!value) issues.push(issue(line, offset + start + 1, 'attribute-required', `属性 ${key} 不能为空。`, null))
    if (value.length > DRAFT_LIMITS.attributeChars) {
      issues.push(issue(line, offset + start + 1, 'attribute-too-long', `属性最多 ${DRAFT_LIMITS.attributeChars} 字符。`, null))
    }
    if (seen.has(key)) issues.push(issue(line, offset + start + 1, 'duplicate-attribute', `属性 ${key} 重复。`, null))
    seen.add(key)
    attributes.push({ name: key, value, column: offset + start + 1 })
  }
  return attributes
}

export function issue(line: number, column: number | null, code: string, message: string, correctExample: string | null): VisualizationDraftIssue {
  return { line, column, code, message, correctExample }
}

export function stableIssues(issues: readonly VisualizationDraftIssue[]): VisualizationDraftIssue[] {
  return [...issues]
    .sort((a, b) => a.line - b.line || (a.column ?? 0) - (b.column ?? 0) || a.code.localeCompare(b.code))
    .slice(0, DRAFT_LIMITS.issues)
}

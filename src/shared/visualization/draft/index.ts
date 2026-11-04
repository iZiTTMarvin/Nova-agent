import { buildVisualizationDraftInteractionScript } from './interaction'
import { issue, parseVisualizationDraft, stableIssues } from './parser'
import { renderVisualizationPanels } from './render'
import type { VisualizationDraftCompileResult, VisualizationDraftIssue } from './types'
import { MAX_VISUALIZATION_HTML_BYTES } from '../contracts'

export type { VisualizationDraftCompileResult, VisualizationDraftIssue } from './types'

export function compileVisualizationDraft(
  source: string,
  options: { readonly mode: 'final' | 'preview' }
): VisualizationDraftCompileResult {
  const parsed = parseVisualizationDraft(source)
  const panels = options.mode === 'preview' ? parsed.panels.filter(panel => panel.terminated) : parsed.panels
  const tailLine = panels.at(-1)?.line ?? 1
  const parseIssues: VisualizationDraftIssue[] = options.mode === 'preview'
    ? parsed.issues.filter(item => item.line <= tailLine)
    : [...parsed.issues]
  if (options.mode === 'final' && !panels.length && !parseIssues.length) {
    parseIssues.push(issue(1, null, 'draft-empty', '草稿至少需要一个 ## 面板。', '## 核心结论\n\n正文内容。'))
  }
  const rendered = renderVisualizationPanels(panels)
  const script = options.mode === 'final' && rendered.interactive ? `<script>${buildVisualizationDraftInteractionScript()}</script>` : ''
  const html = document(rendered.html, script)
  const oversized = new TextEncoder().encode(html).byteLength > MAX_VISUALIZATION_HTML_BYTES
  if (oversized) parseIssues.push(issue(
    panels[0]?.line ?? 1, null, 'compiled-output-too-large',
    '组件展开后超过 2 MiB；请减少重复组件，或拆成多次展示。',
    '## 核心数据\n\n```chart\n项目 | 数值\n关键样本 | 1\n```'
  ))
  const diagnostics = stableIssues([...parseIssues, ...rendered.issues])
  if (options.mode === 'preview') {
    return {
      status: 'preview',
      html: panels.length && !oversized ? html : null,
      completePanelCount: panels.length,
      diagnostics
    }
  }
  if (diagnostics.length) return { status: 'invalid', issues: diagnostics }
  return { status: 'ok', html, panelCount: panels.length, diagnostics: [] }
}

function document(content: string, script = ''): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main class="viz-draft">${content}</main>${script}</body></html>`
}

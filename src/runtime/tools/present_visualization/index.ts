import {
  formatVisualizationResult,
  isVisualizationSessionId,
  MAX_VISUALIZATION_TITLE_CHARS,
  PRESENT_VISUALIZATION_TOOL_NAME
} from '../../../shared/visualization'
import type { VisualizationStore } from '../../visualizations/VisualizationStore'
import { validateVisualizationHtml } from '../../visualizations/validateVisualizationHtml'
import { assertSideEffectAllowed, type ToolExecutor, type ToolResult } from '../types'

export interface PresentVisualizationToolDeps {
  getStore: () => VisualizationStore | null
}

const DESCRIPTION = `Show the user an interactive visual — diagram, chart, simulation, explorable explanation or UI mock — rendered inline in the chat from one self-contained HTML document. Use it when a visual explains better than prose; tables, code, Mermaid and math already render in Markdown.

The page runs in an offline sandbox:
- Inline everything (<style>, <script>, SVG, data: URLs). CDN scripts, web fonts, remote images and network requests all fail; embed the data.
- Height follows the content (up to 1200px inline, then it scrolls); never size to the viewport (no 100vh or height:100%). The chat column is about 700px wide; keep layouts responsive.
- Colors come from Nova's theme through CSS variables: --viz-bg, --viz-surface, --viz-fg, --viz-muted, --viz-border, --viz-accent, --viz-on-accent, --viz-success, --viz-warning, --viz-danger, --viz-series-1 to --viz-series-6, plus --viz-font-sans, --viz-font-mono, --viz-radius. Do not hardcode a color on the page root (:root, html, body): that is rejected before the page is shown, because it would freeze the page on one theme. Colors deeper in the page are allowed, but theme variables are usually the better choice. To follow light and dark, read nova.theme.tokens and redraw in nova.on('theme', fn).
- The frame ships shared classes that already match the app in both themes — prefer them over hand-rolled chrome: .viz-card (surface), .viz-title, .viz-muted, .viz-note, .viz-stat with .viz-stat-label and .viz-stat-value, .viz-grid (equal columns, each cell sized by its own content), .viz-row, .viz-badge, .viz-btn with .viz-btn-primary, .viz-controls, .viz-table, and .viz-s1 to .viz-s6 for series colors. Your own rules always win over them, so restyle freely when a design calls for it.
- When you lay collapsible cards out in a grid, let every cell be sized by its own content (use .viz-grid, or set align-items:start on your own grid). Grids stretch by default, so a collapsed card gets pulled to the height of the tallest card and reads as a large empty box.
- CSS and Web Animations slow down automatically when the user turns on slow motion; scale requestAnimationFrame speed by 1 / nova.motionScale.
- nova.emit(name, data) sends a small JSON event back to you as the user's next message when the user clicks; links open in the system browser.

Each call publishes its own card, so finish the page before showing it instead of showing several drafts. Once it is shown, do not restate its contents in text.`

export function createPresentVisualizationTool(deps: PresentVisualizationToolDeps): ToolExecutor {
  return {
    name: PRESENT_VISUALIZATION_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: `Short title shown above the visual (at most ${MAX_VISUALIZATION_TITLE_CHARS} characters)`
        },
        html: { type: 'string', description: 'The complete, self-contained HTML document' }
      },
      required: ['title', 'html'],
      additionalProperties: false
    },
    // 快照按内容寻址、写入幂等，互不依赖
    executionMode: 'parallel',
    isConcurrencySafe: () => true,
    async execute(args, context): Promise<ToolResult> {
      const title = normalizeTitle(args.title)
      const html = typeof args.html === 'string' ? args.html : ''
      if (!title || !html.trim()) {
        return failure('需要 title（简短标题）与 html（完整的 HTML 文档）。')
      }
      const store = deps.getStore()
      const sessionId = context.sessionId
      if (!store || !sessionId || !isVisualizationSessionId(sessionId)) {
        return failure('当前会话无法展示可视化。')
      }
      const violations = await validateVisualizationHtml(html)
      if (violations.length > 0) {
        return failure(
          [
            '可视化未展示：',
            ...violations.map(violation => `- ${violation}`),
            '页面必须离线自包含并跟随 Nova 主题（样式、脚本、数据与图片全部内联，颜色改用 var(--viz-*) 主题变量），修正后重新调用 present_visualization。'
          ].join('\n')
        )
      }
      assertSideEffectAllowed(context, '展示可视化')
      const published = await store.publish(sessionId, html)
      return {
        success: true,
        output: formatVisualizationResult({ title, uri: published.uri, bytes: published.bytes })
      }
    }
  }
}

/** 标题只做展示：折叠空白、超长截断，不因此拒绝整次调用 */
function normalizeTitle(value: unknown): string {
  if (typeof value !== 'string') return ''
  const compact = value.replace(/\s+/g, ' ').trim()
  const characters = Array.from(compact)
  return characters.length > MAX_VISUALIZATION_TITLE_CHARS
    ? `${characters.slice(0, MAX_VISUALIZATION_TITLE_CHARS - 1).join('')}…`
    : compact
}

function failure(error: string): ToolResult {
  return { success: false, output: '', error }
}

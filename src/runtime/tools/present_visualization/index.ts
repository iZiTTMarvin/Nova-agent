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

const DESCRIPTION = `Show the user an interactive visual — architecture workbench, phased dataflow swimlane, comparison matrix, simulation or chart — rendered inline in the chat from one self-contained HTML document. Use it when spatial topology, multi-dimensional comparison or interactive inspection explains better than prose; simple Q&A, short lists, code snippets and small tables belong in plain Markdown.

Choose the right visual archetype for the question:
1. End-to-end flow / request lifecycle / state machine (especially >6 steps): NEVER cram 9+ steps into a flat horizontal row of tiny pills, and NEVER build a text-only slide deck with just Prev/Next buttons and a paragraph card. Use a two-level workbench (.viz-workbench):
   - Top macro phases (.viz-phases with 3–5 .viz-phase cards, e.g. Input -> Orchestration -> Execution -> Persistence & Render) + optional search/filter (.viz-search) and step transport controls in .viz-toolbar.
   - Left/top visual stage (.viz-canvas with an inline <svg> diagram or .viz-lanes / .viz-lane architectural swimlanes and .viz-node items with .viz-node-step badges and .viz-arrow connectors) showing module boundaries and active step highlights.
   - Right/bottom detail inspector (.viz-split pairing .viz-canvas with .viz-inspector) showing the selected node's role, structured input/output payload (.viz-kv or .viz-code), and real source locations (.viz-file-ref).
2. Software architecture / module map / tech stack: Render a layered topology canvas (<svg> or .viz-lanes grouped by layer) paired with .viz-inspector. Clicking a module highlights its upstream/downstream edges and updates the inspector with responsibilities and key files.
3. Trade-off / solution comparison: Render a structured comparison workbench (.viz-table or .viz-grid + .viz-meter bars + scenario switcher buttons) so switching scenarios or priorities highlights why a design wins and where its boundaries lie.
4. Quantitative metrics / capacity / performance: Render an interactive SVG chart or simulator with parameter controls (.viz-controls) and summary stats (.viz-stat).

Interaction contract (local vs conversation):
- Local UI interactions (clicking a diagram node, switching a phase/step, filtering, toggling views, stepping Prev/Next) MUST update the local DOM/SVG inspector immediately and MUST NOT call nova.emit.
- Reserve nova.emit(name, data) ONLY for explicit follow-up buttons inside the inspector (e.g. a dedicated "深入讲讲此模块" button) when the user intentionally wants to send a new chat turn.

Sandbox and styling rules:
- Inline everything (<style>, <script>, SVG, data: URLs). CDN scripts, web fonts, remote images and network requests all fail; embed the data.
- Height follows the content (up to 1200px inline, then it scrolls); never size to the viewport (no 100vh or height:100%). The chat column is about 700px wide; keep layouts responsive.
- Colors come from Nova's theme through CSS variables: --viz-bg, --viz-surface, --viz-fg, --viz-muted, --viz-border, --viz-accent, --viz-on-accent, --viz-success, --viz-warning, --viz-danger, --viz-series-1 to --viz-series-6, plus --viz-font-sans, --viz-font-mono, --viz-radius. Do not hardcode a color on the page root (:root, html, body): that is rejected before the page is shown, because it would freeze the page on one theme. To follow light and dark dynamically, read nova.theme.tokens and redraw in nova.on('theme', fn).
- Built-in zero-specificity classes (.viz-workbench, .viz-toolbar, .viz-split, .viz-canvas, .viz-inspector, .viz-phases, .viz-phase, .viz-phase-kicker, .viz-phase-title, .viz-lanes, .viz-lane, .viz-lane-label, .viz-lane-nodes, .viz-node, .viz-node-step, .viz-arrow, .viz-card, .viz-title, .viz-muted, .viz-note, .viz-grid, .viz-row, .viz-stat, .viz-stat-label, .viz-stat-value, .viz-badge, .viz-file-ref, .viz-kv, .viz-code, .viz-search, .viz-meter, .viz-btn, .viz-btn-primary, .viz-controls, .viz-table, .viz-s1..s6) already match both themes. When laying collapsible cards out in a grid, use .viz-grid or align-items:start so collapsed cards are not stretched into empty boxes.
- CSS and Web Animations slow down automatically when the user turns on slow motion; scale requestAnimationFrame speed by 1 / nova.motionScale.

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

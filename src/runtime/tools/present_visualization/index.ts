import {
  formatVisualizationResult,
  isVisualizationSessionId,
  MAX_VISUALIZATION_TITLE_CHARS,
  PRESENT_VISUALIZATION_TOOL_NAME
} from '../../../shared/visualization'
import type { VisualizationStore } from '../../visualizations/VisualizationStore'
import { PRESENT_VISUALIZATION_DESCRIPTION } from '../../visualizations/visualAuthoringGuide'
import { validateVisualizationHtml } from '../../visualizations/validateVisualizationHtml'
import { assertSideEffectAllowed, type ToolExecutor, type ToolResult } from '../types'

export interface PresentVisualizationToolDeps {
  getStore: () => VisualizationStore | null
}

export function createPresentVisualizationTool(deps: PresentVisualizationToolDeps): ToolExecutor {
  return {
    name: PRESENT_VISUALIZATION_TOOL_NAME,
    description: PRESENT_VISUALIZATION_DESCRIPTION,
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

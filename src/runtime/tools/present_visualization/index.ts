import {
  formatVisualizationResult,
  isVisualizationSessionId,
  MAX_VISUALIZATION_TITLE_CHARS,
  PRESENT_VISUALIZATION_TOOL_NAME
} from '../../../shared/visualization'
import { compileVisualizationDraft, type VisualizationDraftIssue } from '../../../shared/visualization/draft'
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
        draft: { type: 'string', description: 'The declarative visualization draft; no HTML, CSS, SVG or JavaScript' }
      },
      required: ['title', 'draft'],
      additionalProperties: false
    },
    // 快照按内容寻址、写入幂等，互不依赖
    executionMode: 'parallel',
    isConcurrencySafe: () => true,
    async execute(args, context): Promise<ToolResult> {
      const title = normalizeTitle(args.title)
      const draft = typeof args.draft === 'string' ? args.draft : ''
      if (!title || !draft.trim()) {
        return failure('需要 title（简短标题）与 draft（声明式可视化草稿）。')
      }
      const store = deps.getStore()
      const sessionId = context.sessionId
      if (!store || !sessionId || !isVisualizationSessionId(sessionId)) {
        return failure('当前会话无法展示可视化。')
      }
      const compiled = compileVisualizationDraft(draft, { mode: 'final' })
      if (compiled.status !== 'ok') {
        const issues = compiled.status === 'invalid' ? compiled.issues : compiled.diagnostics
        return failure([
          '可视化草稿未通过校验：',
          ...issues.map(formatIssue),
          '请按草稿行号修正后重新调用 present_visualization；不要改写成 HTML。'
        ].join('\n'))
      }
      const violations = await validateVisualizationHtml(compiled.html)
      if (violations.length > 0) {
        return failure(['编译产物未通过安全校验：', ...violations.map(violation => `- ${violation}`)].join('\n'))
      }
      assertSideEffectAllowed(context, '展示可视化')
      const published = await store.publish(sessionId, compiled.html)
      return {
        success: true,
        output: formatVisualizationResult({ title, uri: published.uri, bytes: published.bytes })
      }
    }
  }
}

function formatIssue(issue: VisualizationDraftIssue): string {
  const column = issue.column === null ? '' : `:${issue.column}`
  const example = issue.correctExample ? `\n  正确示例：\n${issue.correctExample.split('\n').map(line => `  ${line}`).join('\n')}` : ''
  return `- 草稿 ${issue.line}${column} [${issue.code}] ${issue.message}${example}`
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

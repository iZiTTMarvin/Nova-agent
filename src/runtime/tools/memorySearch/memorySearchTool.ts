/**
 * memory_search — 主动检索跨会话记忆（组合检索：结构化 + 文档；可选历史追溯）
 */
import { computeWorkspaceHash } from '../../memory/MemoryPaths'
import { extractMemorySnippet } from '../../memory/memorySnippet'
import type { MemoryRetrievalService } from '../../memory/retrieval/MemoryRetrievalService'
import type { MemoryHistoricalNote, MemorySearchResult } from '../../memory/retrieval/MemoryRetriever'
import type { NovaSettings } from '../../settings/novaSettings'
import type { ToolExecutor, ToolContext, ToolResult } from '../types'

const TOOL_NAME = 'memory_search'

const TOOL_DESCRIPTION = `检索跨会话记忆：项目结构化记忆、手写笔记与全局用户偏好。当遇到项目相关问题、需要回忆此前的决策/约定/踩坑时，先调用此工具查询，再决定是否读文件。
注意：记忆是历史证据，非权威源；使用前应与当前工作区核对。

何时该用：
- 用户问「之前怎么处理的 / 这个项目用什么 / 上次踩过类似的坑吗」
- 你准备读 README/package.json 重新了解项目前
- 涉及项目约定、历史决策、已知问题
- 需要回忆已被替代或撤回的旧方案时，传 history: true

何时不该用：
- 查询当前文件内容（用 read/grep）
- 通用知识问题`

export interface MemorySearchToolDeps {
  getMemoryRetrievalService: () => MemoryRetrievalService | null
  loadSettings: () => NovaSettings
}

/** 历史状态在输出中的标注文案 */
const HISTORICAL_NOTE_LABELS: Record<MemoryHistoricalNote, string> = {
  superseded: '（已被替代）',
  retracted: '（已撤回）',
  'needs-verification': '（需与当前工作区核对）'
}

/** 格式化检索结果为模型可读文本；按来源分组，不输出内部排序分 */
export function formatMemorySearchResults(results: readonly MemorySearchResult[], query: string): string {
  if (results.length === 0) {
    return [
      '未找到相关记忆。',
      '',
      '建议：',
      '1. 换用更具体的关键词（项目名、技术栈、文件名）',
      '2. 需要回忆旧方案/历史变化时可加 history: true 重试',
      '3. 使用 read/grep 直接查看当前工作区文件',
      '4. 若记忆未启用，可在设置中开启跨会话记忆'
    ].join('\n')
  }

  const project: string[] = []
  const globalUser: string[] = []
  const historical: string[] = []

  for (const result of results) {
    if (result.historicalNote !== null) {
      historical.push(renderEntry(result, query, true))
    } else if (result.group === 'structured-global') {
      globalUser.push(renderEntry(result, query, false))
    } else {
      project.push(renderEntry(result, query, false))
    }
  }

  let index = 0
  const lines: string[] = [`找到 ${results.length} 条相关记忆（按相关性排序）：`]
  for (const [title, entries] of [
    ['Project memory:', project],
    ['Global user memory:', globalUser],
    ['Historical memory:', historical]
  ] as const) {
    if (entries.length === 0) {
      continue
    }
    lines.push('', title)
    for (const entry of entries) {
      index += 1
      lines.push(`[${index}] ${entry}`)
    }
  }

  lines.push('', '提示：记忆为历史证据，使用前请与当前工作区核对。')
  return lines.join('\n')
}

function renderEntry(result: MemorySearchResult, query: string, withNote: boolean): string {
  const note =
    withNote && result.historicalNote !== null ? ` ${HISTORICAL_NOTE_LABELS[result.historicalNote]}` : ''
  if (result.group === 'document') {
    const snippet = extractMemorySnippet(result.body, query)
    return `${result.relPath}${note} — ${snippet}`
  }
  const observed = result.explicitness === 'observed' ? ' (observed / advisory)' : ''
  return `[${result.kind}]${note}${observed} ${result.content}`
}

export function createMemorySearchTool(deps: MemorySearchToolDeps): ToolExecutor {
  return {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '检索查询。用自然语言描述你想回忆的内容。'
        },
        history: {
          type: 'boolean',
          description:
            '是否包含历史记录（已被替代/已撤回/待核对的旧记忆）。查询旧方案、历史变化时传 true，默认 false。'
        }
      },
      required: ['query'],
      additionalProperties: false
    },
    executionMode: 'parallel',

    async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      if (!query) {
        return { success: false, output: '', error: 'query 参数不能为空' }
      }
      const history = args.history === true

      const settings = deps.loadSettings()
      if (!settings.memoryEnabled) {
        return {
          success: true,
          output: '记忆系统未启用。请在设置 → 记忆中开启「启用跨会话记忆」后再试。'
        }
      }

      const workingDir = context.workingDir?.trim()
      if (!workingDir) {
        return {
          success: true,
          output: '当前无工作区上下文，无法检索项目记忆。请先打开项目工作区。'
        }
      }

      const retrieval = deps.getMemoryRetrievalService()
      if (!retrieval) {
        return {
          success: true,
          output: '记忆服务暂不可用，请稍后重试。'
        }
      }

      try {
        const results = await retrieval.search({
          query,
          projectScopeId: computeWorkspaceHash(workingDir),
          workspaceRoot: workingDir,
          history,
          limit: settings.memorySearchLimit,
          scoreFloor: settings.memoryScoreFloor
        })

        return {
          success: true,
          output: formatMemorySearchResults(results, query)
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          success: false,
          output: '',
          error: `记忆检索失败：${message}`
        }
      }
    }
  }
}

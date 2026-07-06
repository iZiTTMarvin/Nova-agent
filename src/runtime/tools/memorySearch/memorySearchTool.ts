/**
 * memory_search — 主动检索本项目跨会话记忆（FTS5）
 */
import { computeWorkspaceHash } from '../../memory/MemoryPaths'
import { extractMemorySnippet } from '../../memory/MemoryTailInjector'
import type { MemoryService } from '../../memory/MemoryService'
import type { NovaSettings } from '../../settings/novaSettings'
import type { ToolExecutor, ToolContext, ToolResult } from '../types'

const TOOL_NAME = 'memory_search'

const TOOL_DESCRIPTION = `检索本项目的跨会话记忆。当遇到项目相关问题、需要回忆此前的决策/约定/踩坑时，先调用此工具查询，再决定是否读文件。
注意：记忆是启发式上下文，非权威源；使用前应与当前工作区核对。

何时该用：
- 用户问「之前怎么处理的 / 这个项目用什么 / 上次踩过类似的坑吗」
- 你准备读 README/package.json 重新了解项目前
- 涉及项目约定、历史决策、已知问题

何时不该用：
- 查询当前文件内容（用 read/grep）
- 通用知识问题`

export interface MemorySearchToolDeps {
  getMemoryService: () => MemoryService | null
  loadSettings: () => NovaSettings
}

/** 格式化命中列表为模型可读文本 */
export function formatMemorySearchResults(
  hits: Array<{ relPath: string; body: string; score: number }>,
  query: string
): string {
  if (hits.length === 0) {
    return [
      '未找到相关记忆。',
      '',
      '建议：',
      '1. 换用更具体的关键词（项目名、技术栈、文件名）',
      '2. 使用 read/grep 直接查看当前工作区文件',
      '3. 若记忆未启用，可在设置中开启跨会话记忆'
    ].join('\n')
  }

  const lines: string[] = [`找到 ${hits.length} 条相关记忆（按相关性排序）：`, '']

  hits.forEach((hit, index) => {
    const snippet = extractMemorySnippet(hit.body, query)
    lines.push(`[${index + 1}] ${hit.relPath} (score: ${hit.score.toFixed(2)})`)
    lines.push(snippet)
    lines.push('')
  })

  lines.push('提示：记忆为启发式上下文，使用前请与当前工作区核对。')
  return lines.join('\n')
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

      const memoryService = deps.getMemoryService()
      if (!memoryService) {
        return {
          success: true,
          output: '记忆服务暂不可用，请稍后重试。'
        }
      }

      try {
        const scopeId = computeWorkspaceHash(workingDir)
        const hits = memoryService.search(scopeId, query, {
          limit: settings.memorySearchLimit,
          scoreFloor: settings.memoryScoreFloor
        })

        return {
          success: true,
          output: formatMemorySearchResults(hits, query)
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

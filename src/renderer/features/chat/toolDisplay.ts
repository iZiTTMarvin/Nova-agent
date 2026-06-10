/**
 * 工具卡片显示名称与参数摘要
 * 纯函数，可独立测试，供 ToolBox 组件使用
 */
import { isContentSummary } from '../../../shared/tool-input-sanitizer'

/** 映射工具的中文名 */
export function getToolDisplayName(toolName: string): string {
  switch (toolName) {
    case 'ls':
      return '列出目录内容 (ls)'
    case 'read':
      return '读取文件内容 (read)'
    case 'grep':
      return '检索过滤文本 (grep)'
    case 'find':
      return '模糊检索定位文件 (find)'
    case 'write':
      return '写入文件 (write)'
    case 'edit':
      return '修改文件 (edit)'
    case 'bash':
      return '执行命令 (bash)'
    case 'todo_write':
      return '更新任务列表 (todo_write)'
    default:
      return `运行自动化工具 (${toolName})`
  }
}

/**
 * 统计文本/摘要对象的行数。
 *
 * write/edit 的超大内容在进入 renderer store 前会被摘要化成 ContentSummary。
 * 这里必须兼容两种形态，否则历史会话里的大文件卡片在渲染摘要时会因为
 * `text.replace is not a function` 直接把整个 React 树打崩成白屏。
 *
 * - "a\nb" → 2 行
 * - "a\nb\n" → 2 行（末尾空行不算）
 * - ContentSummary → 直接读持久化时记录好的 `content_lines`
 */
export function countLines(text: unknown): number {
  if (typeof text === 'string') {
    if (!text) return 0
    // 去掉末尾换行后再 split，避免尾随换行多算 1 行
    return text.replace(/\n$/, '').split('\n').length
  }
  if (isContentSummary(text)) {
    return text.content_lines
  }
  return 0
}

/** 根据工具名和参数生成一句话摘要，不需要展开卡片就能看到核心操作信息 */
export function getToolSummary(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case 'write': {
      const path = (args.path as string) || ''
      const lines = countLines(args.content)
      return path ? `正在写入 ${path}（+${lines} 行）` : '正在写入文件'
    }
    case 'edit': {
      const path = (args.filePath as string) || (args.path as string) || ''
      // 替换行数：新格式累加 edits[].oldText 行数；旧格式回退 old。
      const edits = args.edits
      let lines: number
      if (Array.isArray(edits)) {
        lines = edits.reduce((sum: number, e) => {
          const ot = e && typeof e === 'object' ? (e as Record<string, unknown>).oldText : ''
          return sum + countLines(ot)
        }, 0)
      } else {
        const old = args.old
        lines = Math.max(1, countLines(old))
      }
      return path ? `正在修改 ${path}（替换 ${lines} 行）` : '正在修改文件'
    }
    case 'bash': {
      const command = (args.command as string) || ''
      // 截断过长的命令，只显示有效前缀
      const display = command.length > 60 ? command.slice(0, 57) + '...' : command
      return command ? `正在执行 ${display}` : '正在执行命令'
    }
    case 'read': {
      const path = (args.path as string) || ''
      return path ? `读取 ${path}` : '读取文件'
    }
    case 'grep': {
      const pattern = (args.pattern as string) || ''
      const path = (args.path as string) || ''
      return pattern ? `搜索 "${pattern}"${path ? ` 在 ${path}` : ''}` : '搜索文本'
    }
    case 'find': {
      const pattern = (args.pattern as string) || ''
      return pattern ? `搜索 ${pattern}` : '搜索文件'
    }
    case 'ls': {
      const path = (args.path as string) || ''
      return path ? `列出 ${path}` : '列出目录'
    }
    case 'todo_write': {
      const todos = Array.isArray(args.todos) ? args.todos : []
      return `正在更新任务列表（${todos.length} 项）`
    }
    default:
      return ''
  }
}
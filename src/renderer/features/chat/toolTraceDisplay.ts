/**
 * L3 原子行文案：等宽 [Action] [Target]
 *
 * Action 用短英文动词（对齐 Cursor / Codex 轨迹观感），Target 为路径/命令/关键词等核心参数。
 */
import { countLines } from './toolDisplay'
import { isContentSummary } from '../../../shared/tool-input-sanitizer'

const TARGET_MAX = 72

function truncateTarget(text: string, maxLen = TARGET_MAX): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen - 3) + '...'
}

function basenameFromPath(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const parts = normalized.split('/')
  return parts[parts.length - 1] || path
}

/** L3 行动作动词 */
export function getToolTraceAction(toolName: string): string {
  switch (toolName) {
    case 'read':
      return 'Read'
    case 'grep':
      return 'Grepped'
    case 'find':
      return 'Found'
    case 'ls':
      return 'Listed'
    case 'write':
      return 'Wrote'
    case 'edit':
      return 'Edited'
    case 'bash':
      return 'Ran'
    case 'web_search':
      return 'Searched'
    case 'task':
      return 'Task'
    case 'invoke_skill':
      return 'Skill'
    case 'todo_write':
      return 'Todos'
    case 'askQuestion':
      return 'Asked'
    default:
      return toolName
  }
}

/**
 * L3 行 Target：路径、命令前缀、搜索词等。
 * 过长截断；完整内容进 L4。
 */
export function getToolTraceTarget(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case 'read': {
      const path = (args.path as string) || ''
      return path ? truncateTarget(path) : 'file'
    }
    case 'write': {
      const path = (args.path as string) || ''
      const lines = countLines(args.content)
      if (!path) return lines > 0 ? `file +${lines}` : 'file'
      return lines > 0 ? truncateTarget(`${path} +${lines}`) : truncateTarget(path)
    }
    case 'edit': {
      const path = (args.filePath as string) || (args.path as string) || ''
      const edits = args.edits
      let lines: number
      if (Array.isArray(edits)) {
        lines = edits.reduce((sum: number, e) => {
          const ot = e && typeof e === 'object' ? (e as Record<string, unknown>).oldText : ''
          return sum + countLines(ot)
        }, 0)
      } else {
        lines = Math.max(1, countLines(args.old))
      }
      if (!path) return `file ~${lines}`
      return truncateTarget(`${path} ~${lines}`)
    }
    case 'bash': {
      const command = (args.command as string) || ''
      return command ? truncateTarget(command) : 'command'
    }
    case 'grep': {
      const pattern = (args.pattern as string) || ''
      const path = (args.path as string) || ''
      if (!pattern) return 'pattern'
      return path
        ? truncateTarget(`${pattern} in ${path}`)
        : truncateTarget(pattern)
    }
    case 'find': {
      const pattern = (args.pattern as string) || ''
      return pattern ? truncateTarget(pattern) : 'files'
    }
    case 'ls': {
      const path = (args.path as string) || ''
      return path ? truncateTarget(path) : '.'
    }
    case 'web_search': {
      const query = (args.query as string) || ''
      return query ? truncateTarget(query) : 'query'
    }
    case 'task': {
      const sub = (args.subagent_type as string) || ''
      const task = (args.task as string) || ''
      if (sub && task) return truncateTarget(`${sub}: ${task}`)
      if (sub) return truncateTarget(sub)
      return task ? truncateTarget(task) : 'subagent'
    }
    case 'invoke_skill': {
      const skill = (args.skill_name as string) || ''
      const task = (args.task as string) || ''
      if (skill && task) return truncateTarget(`${skill}: ${task}`)
      if (skill) return truncateTarget(skill)
      return task ? truncateTarget(task) : 'skill'
    }
    default: {
      // 兜底：尝试常见 path / command 字段
      const path = (args.path as string) || (args.filePath as string) || ''
      if (path) return truncateTarget(path)
      const command = (args.command as string) || ''
      if (command) return truncateTarget(command)
      return toolName
    }
  }
}

/** write/edit 预览文本（L4 按需挂载时用） */
export function getFileToolPreviewText(toolName: string, args: Record<string, unknown>): string {
  if (toolName === 'write') {
    return extractPreviewText(args.content)
  }
  if (toolName === 'edit') {
    const edits = args.edits
    if (Array.isArray(edits)) {
      return edits
        .map(e => {
          if (e && typeof e === 'object') {
            return extractPreviewText((e as Record<string, unknown>).newText)
          }
          return ''
        })
        .filter(Boolean)
        .join('\n\n')
    }
    return extractPreviewText(args.newText) || extractPreviewText(args.new) || ''
  }
  return ''
}

function extractPreviewText(value: unknown): string {
  if (typeof value === 'string') return value
  if (isContentSummary(value)) {
    return value.content_head + '\n\n... [摘要] ...\n\n' + value.content_tail
  }
  return ''
}

/** 聚合行：Action + 首项 Target + 后缀 */
export function getToolGroupTraceParts(
  toolName: string,
  blocks: Array<{ arguments?: Record<string, unknown> }>
): { action: string; target: string; suffix: string } {
  const count = blocks.length
  const firstArgs = blocks[0]?.arguments ?? {}
  const action = getToolTraceAction(toolName)

  switch (toolName) {
    case 'read': {
      const path = (firstArgs.path as string) || ''
      const name = path ? basenameFromPath(path) : 'file'
      return {
        action,
        target: name,
        suffix: count >= 2 ? `等 ${count} 个文件` : ''
      }
    }
    case 'grep': {
      const pattern = (firstArgs.pattern as string) || ''
      return {
        action,
        target: pattern ? truncateTarget(pattern, 40) : 'pattern',
        suffix: count >= 2 ? `等 ${count} 次` : ''
      }
    }
    case 'find': {
      const pattern = (firstArgs.pattern as string) || ''
      return {
        action,
        target: pattern ? truncateTarget(pattern, 40) : 'files',
        suffix: count >= 2 ? `等 ${count} 次` : ''
      }
    }
    case 'ls': {
      const path = (firstArgs.path as string) || ''
      const name = path ? basenameFromPath(path) : '.'
      return {
        action,
        target: name,
        suffix: count >= 2 ? `等 ${count} 个目录` : ''
      }
    }
    case 'web_search': {
      const query = (firstArgs.query as string) || ''
      return {
        action,
        target: query ? truncateTarget(query, 40) : 'query',
        suffix: count >= 2 ? `等 ${count} 次` : ''
      }
    }
    default:
      return {
        action,
        target: toolName,
        suffix: count >= 2 ? `等 ${count} 次` : ''
      }
  }
}

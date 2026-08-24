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

/**
 * L3 行目标紧凑化：工作区内的绝对路径显示为相对路径（正斜杠），
 * 避免 D:\visual_... 式全路径噪声；区外路径原样保留。
 */
export function compactPathForTrace(path: string, workspaceRoot?: string | null): string {
  if (!path || !workspaceRoot) return path
  const norm = path.replace(/\\/g, '/')
  const root = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!root) return path
  if (norm.toLowerCase().startsWith(root.toLowerCase() + '/')) {
    return norm.slice(root.length + 1)
  }
  return path
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
    case 'save_plan':
      return 'Planned'
    case 'switch_mode':
      return 'Mode'
    case 'run_code':
      return 'Explored'
    default:
      return toolName
  }
}

export type ToolGroupKind = 'explore' | 'write' | 'command'

export function getToolGroupKind(toolName: string): ToolGroupKind | null {
  if (
    toolName === 'read' ||
    toolName === 'grep' ||
    toolName === 'find' ||
    toolName === 'ls' ||
    toolName === 'web_search'
  ) {
    return 'explore'
  }
  if (toolName === 'write' || toolName === 'edit') {
    return 'write'
  }
  if (toolName === 'bash') {
    return 'command'
  }
  return null
}

/**
 * L3 行 Target：路径、命令前缀、搜索词等。
 * 工作区内路径紧凑为相对路径；过长截断；完整内容进 L4。
 */
export function getToolTraceTarget(
  toolName: string,
  args: Record<string, unknown>,
  workspaceRoot?: string | null
): string {
  const compact = (path: string): string => compactPathForTrace(path, workspaceRoot)
  switch (toolName) {
    case 'read': {
      const path = (args.path as string) || ''
      return path ? truncateTarget(compact(path)) : 'file'
    }
    case 'write': {
      const path = (args.path as string) || ''
      const lines = countLines(args.content)
      if (!path) return lines > 0 ? `file +${lines}` : 'file'
      return lines > 0
        ? truncateTarget(`${compact(path)} +${lines}`)
        : truncateTarget(compact(path))
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
      return truncateTarget(`${compact(path)} ~${lines}`)
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
        ? truncateTarget(`${pattern} in ${compact(path)}`)
        : truncateTarget(pattern)
    }
    case 'find': {
      const pattern = (args.pattern as string) || ''
      return pattern ? truncateTarget(pattern) : 'files'
    }
    case 'ls': {
      const path = (args.path as string) || ''
      return path ? truncateTarget(compact(path)) : '.'
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
    case 'save_plan': {
      const title = typeof args.title === 'string' ? args.title : ''
      const lines = countLines(args.content)
      return title
        ? truncateTarget(lines > 0 ? `${title} +${lines}` : title)
        : 'implementation plan'
    }
    case 'switch_mode': {
      const mode = typeof args.mode === 'string' ? args.mode : ''
      return mode ? truncateTarget(mode) : 'mode'
    }
    case 'run_code': {
      const description = typeof args.description === 'string' ? args.description : ''
      return description ? truncateTarget(description) : 'with code'
    }
    default: {
      // 兜底：尝试常见 path / command 字段
      const path = (args.path as string) || (args.filePath as string) || ''
      if (path) return truncateTarget(compact(path))
      const command = (args.command as string) || ''
      if (command) return truncateTarget(command)
      return toolName
    }
  }
}

/** write/edit 预览文本（L4 按需挂载时用） */
export function getFileToolPreviewText(toolName: string, args: Record<string, unknown>): string {
  if (toolName === 'write' || toolName === 'save_plan') {
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

/** L3 行中文动作动词（对齐 Cursor 风格平铺轨迹） */
export function getToolTraceActionChinese(toolName: string): string {
  switch (toolName) {
    case 'read':
      return '已读取'
    case 'grep':
      return '已搜索'
    case 'find':
      return '已查找'
    case 'ls':
      return '已列出'
    case 'write':
      return '已写入'
    case 'edit':
      return '已编辑'
    case 'bash':
      return '已执行'
    case 'web_search':
      return '已搜索'
    case 'task':
      return '已委托'
    case 'invoke_skill':
      return '已调用技能'
    case 'todo_write':
      return '已更新待办'
    case 'askQuestion':
      return '已提问'
    case 'save_plan':
      return '已保存计划'
    case 'switch_mode':
      return '已切换模式'
    case 'run_code':
      return '已探索'
    default:
      return getToolTraceAction(toolName)
  }
}

export interface FilePathParts {
  filename: string
  dir: string
  ext: string
}

/** 拆解路径为文件名、目录前缀与扩展名 */
export function splitFilePath(path: string, workspaceRoot?: string | null): FilePathParts {
  if (!path) return { filename: '', dir: '', ext: '' }
  const relPath = compactPathForTrace(path, workspaceRoot)
  const norm = relPath.replace(/\\/g, '/')
  const lastSlash = norm.lastIndexOf('/')
  if (lastSlash === -1) {
    const ext = norm.includes('.') ? norm.split('.').pop()?.toLowerCase() || '' : ''
    return { filename: norm, dir: '', ext }
  }
  const dir = norm.slice(0, lastSlash + 1)
  const filename = norm.slice(lastSlash + 1)
  const ext = filename.includes('.') ? filename.split('.').pop()?.toLowerCase() || '' : ''
  return { filename, dir, ext }
}

export interface ToolGroupHeaderInfo {
  kind: ToolGroupKind
  title: string
  summaryText: string
  fullSummary: string
}

/** 结构化提取聚合组头部信息（标题、统计与分类） */
export function getToolGroupHeaderInfo(
  blocks: Array<{ toolName?: string }>,
  fallbackToolName?: string
): ToolGroupHeaderInfo | null {
  if (blocks.length === 0) return null
  const names = blocks.map(block => block.toolName ?? fallbackToolName ?? '')
  const groupKind = names.length > 0 ? getToolGroupKind(names[0]) : null
  if (!groupKind || !names.every(name => getToolGroupKind(name) === groupKind)) {
    return null
  }

  if (groupKind === 'explore') {
    const fileCount = names.filter(name => name === 'read').length
    const directoryCount = names.filter(name => name === 'ls').length
    const searchCount = names.filter(
      name => name === 'grep' || name === 'find' || name === 'web_search'
    ).length
    const parts: string[] = []
    if (searchCount > 0) parts.push(`${searchCount} 搜索`)
    if (fileCount > 0) parts.push(`${fileCount} 文件`)
    if (directoryCount > 0) parts.push(`${directoryCount} 目录`)
    const summaryText = parts.join(' ') || `${blocks.length} 项探索`
    const title = '探索'
    const fullSummary = `已探索 ${summaryText}`
    return { kind: 'explore', title, summaryText, fullSummary }
  }

  if (groupKind === 'write') {
    const writeCount = names.filter(name => name === 'write').length
    const editCount = names.filter(name => name === 'edit').length
    const parts: string[] = []
    if (writeCount > 0) parts.push(`${writeCount} 写入`)
    if (editCount > 0) parts.push(`${editCount} 编辑`)
    const summaryText = parts.join(' ') || `${blocks.length} 文件`
    const title = '写入'
    const fullSummary = `已写入 ${summaryText}`
    return { kind: 'write', title, summaryText, fullSummary }
  }

  const title = '运行'
  const summaryText = `${blocks.length} 条命令`
  const fullSummary = `已运行 ${summaryText}`
  return { kind: 'command', title, summaryText, fullSummary }
}

/** 摘要组折叠头：整句中文，展开后仍用各行英文短动词。 */
export function getToolGroupHeadline(
  blocks: Array<{ toolName?: string }>,
  fallbackToolName?: string
): string | null {
  const info = getToolGroupHeaderInfo(blocks, fallbackToolName)
  return info ? info.fullSummary : null
}

/** 聚合行：整句中文摘要进 action；无摘要时回退到单工具 L3 文案。 */
export function getToolGroupTraceParts(
  toolName: string,
  blocks: Array<{ toolName?: string; arguments?: Record<string, unknown> }>
): { action: string; target: string; suffix: string } {
  const info = getToolGroupHeaderInfo(blocks, toolName)
  if (info) {
    return {
      action: info.title,
      target: info.summaryText,
      suffix: ''
    }
  }

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

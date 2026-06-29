/**
 * Todo 消息流快照解析（只读 block.arguments，不订阅 useTodoStore）
 */
import { normalizeTodos } from '../../../shared/todo/normalize'
import type { TodoItem } from '../../../shared/todo/types'

/** 从 todo_write 工具参数解析快照列表 */
export function parseTodoSnapshot(args: Record<string, unknown>): TodoItem[] {
  return normalizeTodos(args.todos)
}

/** 统计进度：cancelled 不计入 completed */
export function countTodoProgress(todos: TodoItem[]): { completed: number; total: number } {
  const total = todos.length
  const completed = todos.filter(t => t.status === 'completed').length
  return { completed, total }
}

/** 常见源码文件扩展名，用于内联路径高亮 */
const FILE_EXT_PATTERN =
  /\b[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|css|scss|html|vue|py|go|rs|java|kt|yaml|yml|toml)\b/g

export type TodoContentSegment =
  | { type: 'text'; value: string }
  | { type: 'code'; value: string }

/**
 * 将任务文案拆成普通文本与等宽高亮片段（反引号内容 + 文件路径）。
 */
export function splitTodoContentSegments(content: string): TodoContentSegment[] {
  const segments: TodoContentSegment[] = []
  let i = 0

  while (i < content.length) {
    const tick = content.indexOf('`', i)
    if (tick === -1) {
      pushTextWithFileHighlights(content.slice(i), segments)
      break
    }

    if (tick > i) {
      pushTextWithFileHighlights(content.slice(i, tick), segments)
    }

    const close = content.indexOf('`', tick + 1)
    if (close === -1) {
      pushTextWithFileHighlights(content.slice(tick), segments)
      break
    }

    const inner = content.slice(tick + 1, close)
    if (inner) {
      segments.push({ type: 'code', value: inner })
    }
    i = close + 1
  }

  return mergeAdjacentTextSegments(segments)
}

function pushTextWithFileHighlights(text: string, segments: TodoContentSegment[]): void {
  if (!text) return

  let last = 0
  for (const match of text.matchAll(FILE_EXT_PATTERN)) {
    const index = match.index ?? 0
    if (index > last) {
      segments.push({ type: 'text', value: text.slice(last, index) })
    }
    segments.push({ type: 'code', value: match[0] })
    last = index + match[0].length
  }

  if (last < text.length) {
    segments.push({ type: 'text', value: text.slice(last) })
  }
}

function mergeAdjacentTextSegments(segments: TodoContentSegment[]): TodoContentSegment[] {
  const merged: TodoContentSegment[] = []
  for (const seg of segments) {
    const prev = merged[merged.length - 1]
    if (seg.type === 'text' && prev?.type === 'text') {
      prev.value += seg.value
    } else {
      merged.push({ ...seg })
    }
  }
  return merged
}

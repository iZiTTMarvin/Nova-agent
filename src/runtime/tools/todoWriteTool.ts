/**
 * todoWriteTool — 会话级任务列表写入工具
 *
 * 模型通过本工具把"当前计划"显式外化为会话级持久化状态。
 * 每次调用都是全量替换：模型在每一步里都拥有完整全图，避免"刚才是不是已经把这条加进去了"的歧义。
 *
 * 设计要点：
 * - executionMode: 'parallel'、isConcurrencySafe: true（纯内存写，无副作用）
 * - normalize 兜底：缺失字段补默认值、空 content 丢弃、非法 status 降级
 * - 写入只走 sessionStore.updateTodos；事件通过 eventBus.emit 一次性发出（含 view）
 * - 输出 JSON 与 kilocode 对齐，方便模型复用既有阅读习惯
 */
import type { ToolExecutor, ToolContext, ToolResult } from './types'
import type { TodoItem, TodoStatus, TodoPriority, TodoViewInfo } from '../../shared/todo/types'
import { TODO_STATUSES, TODO_PRIORITIES } from '../../shared/todo/types'
import { calculateTodoView } from './todoView'
import { TODO_WRITE_DESCRIPTION } from './todoWriteDescription'

/**
 * 把模型传入的入参做防御性归一化，丢弃脏数据、补默认值。
 * 失败/缺字段策略与 kilocode 对齐但更稳：优先降级而不是抛错，
 * 因为这类工具是"模型自检契约"的一部分，硬失败会让 AgentLoop 主循环卡住。
 */
export function normalizeTodos(input: unknown): TodoItem[] {
  if (!Array.isArray(input)) {
    return []
  }

  const result: TodoItem[] = []
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue
    const obj = raw as Record<string, unknown>

    const content = typeof obj.content === 'string' ? obj.content.trim() : ''
    if (!content) {
      // 空 content 直接丢弃；模型把空串塞进来常见于"先占位再补"的草稿状态
      continue
    }

    const status: TodoStatus = TODO_STATUSES.includes(obj.status as TodoStatus)
      ? (obj.status as TodoStatus)
      : 'pending'

    const priority: TodoPriority = TODO_PRIORITIES.includes(obj.priority as TodoPriority)
      ? (obj.priority as TodoPriority)
      : 'medium'

    result.push({ content, status, priority })
  }
  return result
}

function formatTodosOutput(todos: TodoItem[]): string {
  if (todos.length === 0) {
    return 'Todo list updated (empty).'
  }
  return JSON.stringify(todos, null, 2)
}

/**
 * 构造 todo_write 工具的执行器
 *
 * 注意：executionMode/parameters 字段是常量，但 description 必须在文件加载时
 * 拿到 TODO_WRITE_DESCRIPTION 字符串（避免循环依赖）。
 */
export const todoWriteTool: ToolExecutor = {
  name: 'todo_write',
  description: TODO_WRITE_DESCRIPTION,
  executionMode: 'parallel',
  isConcurrencySafe: () => true,
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: '更新后的完整 todo 列表（每次都是全量替换）',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: '任务描述' },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed', 'cancelled'],
              description: '任务状态'
            },
            priority: {
              type: 'string',
              enum: ['high', 'medium', 'low'],
              description: '优先级'
            }
          },
          required: ['content', 'status', 'priority']
        }
      }
    },
    required: ['todos']
  },

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const sessionStore = context.sessionStore
    const sessionId = context.sessionId
    const eventBus = context.eventBus

    if (!sessionStore || !sessionId || !eventBus) {
      // 没有会话上下文（旧调用方漏传）→ 兜底为 no-op，避免主循环崩溃
      return {
        success: true,
        output: JSON.stringify({ ok: true, skipped: true, reason: 'no session context' }, null, 2)
      }
    }

    const todos = normalizeTodos(args.todos)
    // 一次 update 同时拿到写入前快照（previousTodos）与写入后持久化结果，
    // 避免之前 getTodos + updateTodos 造成的双次读盘。
    const result = sessionStore.updateTodos(sessionId, todos)
    if (!result) {
      return {
        success: true,
        output: JSON.stringify({ ok: true, skipped: true, reason: 'session not found' }, null, 2)
      }
    }
    const view: TodoViewInfo = calculateTodoView(result.previousTodos, todos)

    // 写一次 store、emit 一次事件；顺序固定：先写后广播，
    // 保证订阅方拿到 view 时 store 已落盘（renderer 读 view 不需要再回查）
    eventBus.emit({
      type: 'todos_updated',
      sessionId,
      todos,
      view
    })

    return {
      success: true,
      output: formatTodosOutput(todos)
    }
  }
}

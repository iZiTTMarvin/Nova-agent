/**
 * todoWriteTool 单元测试
 *
 * 覆盖 task 文档 2 中列出的全部场景：
 * - 正常全量替换（store 更新 + emit + 返回 JSON）
 * - 缺 status → pending
 * - 缺 priority → medium
 * - 空 content → 丢弃
 * - 空 todos 数组 → store 清空 + emit
 * - 非法 status 降级
 * - context 缺 sessionStore/sessionId 时不崩溃
 * - sessionStore.updateTodos 返回 null（会话不存在）→ 兜底 ok
 * - 写入前快照 previousTodos 正确传入 calculateTodoView
 */
import { describe, expect, it, vi } from 'vitest'
import { todoWriteTool } from '../../../../src/runtime/tools/todoWriteTool'
import type { ToolContext } from '../../../../src/runtime/tools/types'
import type { EventBus } from '../../../../src/runtime/agent/EventBus'
import type { TodoItem, TodoViewInfo } from '../../../../src/shared/todo/types'

/** SessionStore.updateTodos 的返回类型（与 SessionStore 内部签名对齐） */
type UpdateTodosResult = { session: any; previousTodos: TodoItem[] }

type MockSessionStore = {
  updateTodos: (id: string, todos: TodoItem[]) => UpdateTodosResult | null
}

function createContext(opts: {
  sessionStore?: MockSessionStore
  sessionId?: string
  eventBus?: { emit: (event: any) => void }
} = {}): { context: ToolContext; events: any[]; sessionStore: MockSessionStore } {
  const events: any[] = []
  // 默认 mock：updateTodos 返回空快照 + 空 session，调用一次
  const sessionStore: MockSessionStore = opts.sessionStore ?? {
    updateTodos: vi.fn(() => ({ session: {}, previousTodos: [] as TodoItem[] }))
  }
  const eventBus = opts.eventBus ?? { emit: vi.fn((e: any) => events.push(e)) }
  return {
    context: {
      workingDir: process.cwd(),
      sessionStore: sessionStore as any,
      ...(opts.sessionId ? { sessionId: opts.sessionId } : { sessionId: 'sess_test' }),
      eventBus: eventBus as unknown as EventBus
    },
    events,
    sessionStore
  }
}

describe('todoWriteTool.execute', () => {
  it('正常替换：store 更新、emit todos_updated、返回 JSON', async () => {
    const { context, events, sessionStore } = createContext()
    const todos = [
      { content: 'A', status: 'in_progress', priority: 'high' },
      { content: 'B', status: 'pending', priority: 'medium' }
    ]

    const result = await todoWriteTool.execute({ todos }, context)

    expect(result.success).toBe(true)
    expect(sessionStore.updateTodos).toHaveBeenCalledWith('sess_test', todos)
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('todos_updated')
    expect(events[0].sessionId).toBe('sess_test')
    expect(events[0].todos).toEqual(todos)
    expect(events[0].view.mode).toBe('full')
    expect(result.output).toContain('"content": "A"')
  })

  it('空 todos 数组 → store 清空 + 仍 emit', async () => {
    const { context, events, sessionStore } = createContext()
    const result = await todoWriteTool.execute({ todos: [] }, context)

    expect(result.success).toBe(true)
    expect(sessionStore.updateTodos).toHaveBeenCalledWith('sess_test', [])
    expect(events).toHaveLength(1)
    expect(events[0].todos).toEqual([])
    expect(events[0].view.mode).toBe('full')
  })

  it('缺 status 字段 → 默认 pending', async () => {
    const { context, events, sessionStore } = createContext()
    const result = await todoWriteTool.execute(
      { todos: [{ content: 'A', priority: 'high' }] },
      context
    )

    expect(result.success).toBe(true)
    expect(sessionStore.updateTodos).toHaveBeenCalledWith('sess_test', [
      { content: 'A', status: 'pending', priority: 'high' }
    ])
    expect(events[0].todos[0].status).toBe('pending')
  })

  it('缺 priority 字段 → 默认 medium', async () => {
    const { context, events } = createContext()
    await todoWriteTool.execute(
      { todos: [{ content: 'A', status: 'pending' }] },
      context
    )
    expect(events[0].todos[0].priority).toBe('medium')
  })

  it('空 content → 该条被丢弃', async () => {
    const { context, events, sessionStore } = createContext()
    await todoWriteTool.execute(
      {
        todos: [
          { content: '', status: 'pending', priority: 'medium' },
          { content: 'Keep', status: 'pending', priority: 'medium' }
        ]
      },
      context
    )
    expect(sessionStore.updateTodos).toHaveBeenCalledWith('sess_test', [
      { content: 'Keep', status: 'pending', priority: 'medium' }
    ])
    expect(events[0].todos).toHaveLength(1)
  })

  it('非法 status → 降级 pending', async () => {
    const { context, events, sessionStore } = createContext()
    await todoWriteTool.execute(
      { todos: [{ content: 'A', status: 'invalid_state', priority: 'high' }] },
      context
    )
    expect(sessionStore.updateTodos).toHaveBeenCalledWith('sess_test', [
      { content: 'A', status: 'pending', priority: 'high' }
    ])
    expect(events[0].todos[0].status).toBe('pending')
  })

  it('view 字段：before 已有 5 项，本次第 2 项状态变化 → compact', async () => {
    const before: TodoItem[] = [
      { content: 'A', status: 'pending', priority: 'medium' },
      { content: 'B', status: 'pending', priority: 'medium' },
      { content: 'C', status: 'pending', priority: 'medium' },
      { content: 'D', status: 'pending', priority: 'medium' },
      { content: 'E', status: 'pending', priority: 'medium' }
    ]
    // updateTodos 直接返回 previousTodos（写入前的旧列表）
    const sessionStore: MockSessionStore = {
      updateTodos: vi.fn(() => ({ session: {}, previousTodos: before }))
    }
    const { context, events } = createContext({ sessionStore })

    const after = [
      { content: 'A', status: 'pending', priority: 'medium' },
      { content: 'B', status: 'in_progress', priority: 'medium' },
      { content: 'C', status: 'pending', priority: 'medium' },
      { content: 'D', status: 'pending', priority: 'medium' },
      { content: 'E', status: 'pending', priority: 'medium' }
    ]
    await todoWriteTool.execute({ todos: after }, context)

    const view: TodoViewInfo = events[0].view
    expect(view.mode).toBe('compact')
    expect(view.todos.find(t => t.changed)?.content).toBe('B')
  })

  it('写入前快照 previousTodos 必须来自 updateTodos 返回值，不是来自独立的 getTodos', async () => {
    // 故意让 previousTodos 不同于"独立 getTodos 应返回的"——验证工具不再调用 getTodos
    const staleSnapshot: TodoItem[] = [{ content: 'STALE', status: 'pending', priority: 'medium' }]
    const sessionStore: MockSessionStore = {
      updateTodos: vi.fn(() => ({ session: {}, previousTodos: staleSnapshot }))
    }
    const { context, events } = createContext({ sessionStore })

    const after: TodoItem[] = [{ content: 'A', status: 'pending', priority: 'medium' }]
    await todoWriteTool.execute({ todos: after }, context)

    // 全量替换：before 长度 1 vs after 长度 1，但 content 不同 → full + changed = 1
    const view: TodoViewInfo = events[0].view
    expect(view.mode).toBe('full')
    expect(view.changed).toBe(1)
    // 关键：view 是基于 previousTodos 与 todos 计算出来的；如果工具偷偷调了 getTodos
    // 拿到空数组，changed 仍为 1（与本测试不冲突），所以下面这条断言才能命中：
    //   changed 计数应等于 previousTodos 与 todos 的"位置相同但内容不同"条目数。
    expect(view.todos[0].content).toBe('A')
  })

  it('sessionStore.updateTodos 返回 null（会话不存在）→ 兜底 ok，emit 不触发', async () => {
    const sessionStore: MockSessionStore = {
      updateTodos: vi.fn(() => null)
    }
    const { context, events } = createContext({ sessionStore })

    const result = await todoWriteTool.execute(
      { todos: [{ content: 'A', status: 'pending', priority: 'medium' }] },
      context
    )

    expect(result.success).toBe(true)
    expect(result.output).toContain('session not found')
    expect(events).toHaveLength(0)
  })

  it('无 sessionStore/sessionId → 跳过写入与 emit，返回 ok:true 兜底', async () => {
    const result = await todoWriteTool.execute(
      { todos: [{ content: 'A', status: 'pending', priority: 'medium' }] },
      { workingDir: process.cwd() } as ToolContext
    )
    expect(result.success).toBe(true)
    expect(result.output).toContain('skipped')
  })
})

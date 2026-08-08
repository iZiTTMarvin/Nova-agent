/**
 * 会话待办水合：重开/切换会话时，load-session 详情里的 todos 必须灌入 useTodoStore，
 * 让 TodoPanel 与 compose 阶段条进度立即可见，而不是等下一次 todo_write 推送。
 * 旧会话详情没有 todos 字段时不得制造空状态。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceState } from '../../../../src/shared/workspace/types'
import type { TodoItem } from '../../../../src/shared/todo/types'
import {
  resetWorkspaceDispatcherForTests,
  dispatchWorkspaceChange
} from '../../../../src/renderer/stores/workspaceDispatcher'
import {
  resetChatStoreForTests,
  useChatStore
} from '../../../../src/renderer/stores/useChatStore'
import { useTodoStore, selectSessionTodoState } from '../../../../src/renderer/features/todo/useTodoStore'

const sessionId = 'session-todo'

const persistedTodos: TodoItem[] = [
  { content: '接入登录接口', status: 'completed', priority: 'high' },
  { content: '补充单测', status: 'in_progress', priority: 'medium' },
  { content: '联调验收', status: 'pending', priority: 'low' }
]

function workspaceState(): WorkspaceState {
  return {
    currentProjectPath: '/test/project',
    currentSessionId: sessionId,
    currentMode: 'default',
    availableSessions: [
      {
        id: sessionId,
        workspaceRoot: '/test/project',
        mode: 'default',
        createdAt: 1,
        updatedAt: 2,
        messageCount: 1,
        title: 'A'
      }
    ],
    messagesRevision: 1,
    tier1BranchContext: null
  }
}

function sessionDetailWithTodos(todos?: TodoItem[]) {
  return {
    id: sessionId,
    workspaceRoot: '/test/project',
    mode: 'default' as const,
    createdAt: 1,
    updatedAt: 2,
    messageCount: 1,
    messages: [
      { id: 'user-A', sessionId, role: 'user', content: '开始', timestamp: 1 }
    ],
    ...(todos ? { todos } : {})
  }
}

function installApiMock(detail: unknown): void {
  global.window = {
    ...global.window,
    api: {
      invoke: vi.fn(async (channel: string) => {
        if (channel === 'load-session') return detail
        if (channel === 'run:get-snapshot') return { snapshot: null, waitingSessions: [] }
        if (channel === 'run:list-waiting') return []
        return undefined
      }),
      on: vi.fn(),
      removeAllListeners: vi.fn()
    }
  } as unknown as Window & typeof globalThis
}

describe('会话待办水合', () => {
  beforeEach(() => {
    resetChatStoreForTests()
    resetWorkspaceDispatcherForTests()
    useTodoStore.getState().reset()
  })

  it('load-session 详情带 todos 时灌入 todo store，进度与完整列表立即可见', async () => {
    installApiMock(sessionDetailWithTodos(persistedTodos))

    dispatchWorkspaceChange(workspaceState())

    await vi.waitFor(() => {
      expect(useChatStore.getState().currentSessionId).toBe(sessionId)
      const state = selectSessionTodoState(useTodoStore.getState(), sessionId)
      expect(state).not.toBeNull()
      expect(state!.todos.map(todo => todo.content)).toEqual([
        '接入登录接口', '补充单测', '联调验收'
      ])
      expect(state!.completed).toBe(1)
      expect(state!.total).toBe(3)
      // 水合数据必须可直接渲染（full 视图），否则面板只有总数没有条目
      expect(state!.view.mode).toBe('full')
      expect(state!.view.todos).toHaveLength(3)
    })
  })

  it('旧会话详情没有 todos 字段时不制造空状态', async () => {
    installApiMock(sessionDetailWithTodos(undefined))

    dispatchWorkspaceChange(workspaceState())

    await vi.waitFor(() => {
      expect(useChatStore.getState().currentSessionId).toBe(sessionId)
      expect(useChatStore.getState().messages).toHaveLength(1)
    })
    expect(selectSessionTodoState(useTodoStore.getState(), sessionId)).toBeNull()
  })
})

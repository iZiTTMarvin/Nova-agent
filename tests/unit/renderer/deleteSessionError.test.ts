/**
 * 删除运行中会话：主进程拒绝时错误必须上抛到 UI 层
 *
 * 回归对象：主进程 WorkspaceService.deleteSession 对运行中会话抛错后，
 * workspace/chat 两层 store 曾各自吞掉错误，确认对话框关闭后用户零反馈。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useChatStore, resetChatStoreForTests } from '../../../src/renderer/stores/useChatStore'
import {
  useWorkspaceStore,
  resetWorkspaceStoreForTests
} from '../../../src/renderer/stores/useWorkspaceStore'

const mockInvoke = vi.fn()
const RUNNING_REJECTION = '该会话或其子任务的 Agent 正在运行，请先停止再删除'

describe('删除会话错误上抛', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetChatStoreForTests()
    resetWorkspaceStoreForTests()
    global.window = {
      ...global.window,
      api: {
        invoke: mockInvoke,
        on: vi.fn(() => () => {}),
        removeAllListeners: vi.fn()
      }
    } as unknown as Window & typeof globalThis
  })

  it('workspace store 不吞错误：删除被拒时 reject 给调用方', async () => {
    mockInvoke.mockRejectedValue(new Error(RUNNING_REJECTION))

    await expect(useWorkspaceStore.getState().deleteSession('sessA')).rejects.toThrow(
      '请先停止再删除'
    )
    expect(mockInvoke).toHaveBeenCalledWith('workspace:delete-session', { sessionId: 'sessA' })
  })

  it('chat store 转发错误：组件层 catch 后能拿到主进程提示并展示', async () => {
    mockInvoke.mockRejectedValue(new Error(RUNNING_REJECTION))

    await expect(useChatStore.getState().deleteSession('sessA')).rejects.toThrow(
      '该会话或其子任务的 Agent 正在运行'
    )
  })

  it('删除成功时正常返回并派发工作区变更（不回归主路径）', async () => {
    const workspaceState = {
      currentSessionId: null,
      currentProjectPath: '/ws',
      currentMode: 'default',
      availableSessions: [],
      messagesRevision: 0
    }
    mockInvoke.mockResolvedValue(workspaceState)

    await expect(useChatStore.getState().deleteSession('sessA')).resolves.toBeUndefined()
    expect(mockInvoke).toHaveBeenCalledWith('workspace:delete-session', { sessionId: 'sessA' })
  })
})

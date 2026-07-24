/**
 * useWorkspaceStore — 工作区单一事实源在 renderer 侧的转发层
 *
 * 与 PRD §5.1 对齐。职责：
 * 1. 启动时 workspace:get 拉取初始状态。
 * 2. 维护 currentSessionId / currentProjectPath / currentMode / availableSessions（由 dispatcher 写入）。
 * 3. 提供派生 action（只转发 IPC；invoke 返回后由 dispatcher 统一分发副作用，不自己 setState）。
 *
 * 数据流（单向）：
 *   UI action → 转发 IPC → 主进程操作 → workspace:changed 广播 → dispatcher 分发到四 store
 *   action 的 invoke 返回值也会触发一次 dispatch（覆盖"主进程未广播"的边界，如取消对话框）。
 *
 * 注意：本 store 的状态字段由 workspaceDispatcher.dispatchWorkspaceChange 写入，
 * action 不直接 setState（避免与广播双写产生歧义）。
 */
import { create } from 'zustand'
import type { Mode, Session, BranchMeta } from '../../shared/session/types'
import type { WorkspaceState } from '../../shared/workspace/types'

export interface WorkspaceStoreState {
  // ── 状态（由 dispatcher 写入） ──
  currentSessionId: string | null
  currentProjectPath: string | null
  currentMode: Mode
  availableSessions: Session[]
  /** 启动时是否已完成首次 workspace:get 拉取 */
  initialized: boolean

  // ── Actions（只转发 IPC） ──
  /** 启动时拉取初始状态（App 顶层调用一次，内部会 dispatch） */
  init: () => Promise<void>
  /** 选择项目（弹对话框），成功后自动建会话 */
  selectProject: () => Promise<void>
  /** 创建新会话 */
  createSession: (workspaceRoot: string, mode?: Mode) => Promise<void>
  /** 删除会话 */
  deleteSession: (sessionId: string) => Promise<void>
  /** 重命名会话标题 */
  renameSession: (sessionId: string, title: string) => Promise<void>
  /** 切换会话 */
  selectSession: (sessionId: string) => Promise<void>
  /** 切换模式 */
  setMode: (mode: Mode) => Promise<void>
  /** 重新生成助手消息的分叉准备 */
  prepareRegenerate: (sessionId: string, messageId: string) => Promise<void>
  /** 切换到兄弟分支 */
  switchBranch: (sessionId: string, targetMessageId: string) => Promise<void>
  /** 递增 messagesRevision，触发同会话消息重拉 */
  bumpMessagesRevision: () => Promise<void>
  /** 编辑用户消息并重发的分叉准备（undo 文件 + 倒回 currentLeafId 到分叉点） */
  prepareEditResend: (sessionId: string, messageId: string) => Promise<void>
}

export const useWorkspaceStore = create<WorkspaceStoreState>(() => ({
  currentSessionId: null,
  currentProjectPath: null,
  currentMode: 'default',
  availableSessions: [],
  initialized: false,

  init: async () => {
    try {
      const state = await window.api.invoke('workspace:get')
      // 延迟导入避免循环依赖（dispatcher 导入本 store）
      const { dispatchWorkspaceChange } = await import('./workspaceDispatcher')
      dispatchWorkspaceChange(state)
    } catch (err) {
      console.error('[useWorkspaceStore] 初始化失败:', err)
      useWorkspaceStore.setState({ initialized: true })
    }
  },

  selectProject: async () => {
    try {
      const state = await window.api.invoke('workspace:select-project', {})
      const { dispatchWorkspaceChange } = await import('./workspaceDispatcher')
      dispatchWorkspaceChange(state)
    } catch (err) {
      console.error('[useWorkspaceStore] 选择项目失败:', err)
    }
  },

  createSession: async (workspaceRoot: string, mode?: Mode) => {
    try {
      const state = await window.api.invoke('workspace:create-session', { workspaceRoot, mode })
      const { dispatchWorkspaceChange } = await import('./workspaceDispatcher')
      dispatchWorkspaceChange(state)
    } catch (err) {
      console.error('[useWorkspaceStore] 创建会话失败:', err)
    }
  },

  deleteSession: async (sessionId: string) => {
    try {
      const state = await window.api.invoke('workspace:delete-session', { sessionId })
      const { dispatchWorkspaceChange } = await import('./workspaceDispatcher')
      dispatchWorkspaceChange(state)
    } catch (err) {
      console.error('[useWorkspaceStore] 删除会话失败:', err)
    }
  },

  renameSession: async (sessionId: string, title: string) => {
    try {
      const state = await window.api.invoke('workspace:rename-session', { sessionId, title })
      const { dispatchWorkspaceChange } = await import('./workspaceDispatcher')
      dispatchWorkspaceChange(state)
    } catch (err) {
      console.error('[useWorkspaceStore] 重命名会话失败:', err)
      throw err
    }
  },

  selectSession: async (sessionId: string) => {
    try {
      const state = await window.api.invoke('workspace:select-session', { sessionId })
      const { dispatchWorkspaceChange } = await import('./workspaceDispatcher')
      dispatchWorkspaceChange(state)
    } catch (err) {
      console.error('[useWorkspaceStore] 切换会话失败:', err)
    }
  },

  setMode: async (mode: Mode) => {
    try {
      const state = await window.api.invoke('workspace:set-mode', { mode })
      const { dispatchWorkspaceChange } = await import('./workspaceDispatcher')
      dispatchWorkspaceChange(state)
    } catch (err) {
      console.error('[useWorkspaceStore] 切换模式失败:', err)
      throw err
    }
  },

  prepareRegenerate: async (sessionId: string, messageId: string) => {
    const state = await window.api.invoke('workspace:regenerate', { sessionId, messageId })
    const { dispatchWorkspaceChange } = await import('./workspaceDispatcher')
    dispatchWorkspaceChange(state)
  },

  switchBranch: async (sessionId: string, targetMessageId: string) => {
    const state = await window.api.invoke('workspace:switch-branch', { sessionId, targetMessageId })
    const { dispatchWorkspaceChange } = await import('./workspaceDispatcher')
    dispatchWorkspaceChange(state)
  },

  bumpMessagesRevision: async () => {
    const state = await window.api.invoke('workspace:bump-messages-revision')
    const { dispatchWorkspaceChange } = await import('./workspaceDispatcher')
    dispatchWorkspaceChange(state)
  },

  prepareEditResend: async (sessionId: string, messageId: string) => {
    // 不吞错：失败时让调用方（useChatStore.editResend）据此中止后续乐观截断与发送
    const state = await window.api.invoke('workspace:edit-resend', { sessionId, messageId })
    const { dispatchWorkspaceChange } = await import('./workspaceDispatcher')
    dispatchWorkspaceChange(state)
  }
}))

/** 重置整个 workspace store 到默认值。供测试 setup 复用。 */
export function resetWorkspaceStoreForTests(): void {
  useWorkspaceStore.setState({
    currentSessionId: null,
    currentProjectPath: null,
    currentMode: 'default',
    availableSessions: [],
    initialized: false
  })
}

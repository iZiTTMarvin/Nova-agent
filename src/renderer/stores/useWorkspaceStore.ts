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
import type { Mode, Session } from '../../shared/session/types'
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
  /** 切换会话 */
  selectSession: (sessionId: string) => Promise<void>
  /** 切换模式 */
  setMode: (mode: Mode) => Promise<void>
  /** 回滚消息 */
  rollbackMessage: (sessionId: string, messageId: string) => Promise<void>
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
    }
  },

  rollbackMessage: async (sessionId: string, messageId: string) => {
    try {
      const state = await window.api.invoke('workspace:rollback-message', { sessionId, messageId })
      const { dispatchWorkspaceChange } = await import('./workspaceDispatcher')
      dispatchWorkspaceChange(state)
    } catch (err) {
      console.error('[useWorkspaceStore] 回滚消息失败:', err)
    }
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

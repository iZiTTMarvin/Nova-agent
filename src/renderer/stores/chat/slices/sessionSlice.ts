import type { Session } from '../../../../shared/session/types'
import type { ChatSliceCreator, SessionSliceState } from '../types'

export function initialSessionState(): Pick<
  SessionSliceState,
  'sessions' | 'currentSessionId' | 'currentSubagentTask'
> {
  return { sessions: [], currentSessionId: null, currentSubagentTask: null }
}

/**
 * 会话列表与当前会话的 owner。会话切换的真源是主进程广播
 * （workspace:changed → syncFromWorkspace），本 slice 的 CRUD 只转发到
 * workspace store，不直接改写 currentSessionId。
 */
export const createSessionSlice: ChatSliceCreator<SessionSliceState> = (set) => ({
  ...initialSessionState(),

  loadSessions: async () => {
    try {
      const sessions: Session[] = await window.api.invoke('load-sessions')
      set({ sessions })
    } catch (err) {
      console.error('加载会话列表出错:', err)
    }
  },

  selectSession: async (sessionId: string) => {
    // 会话切换统一走 workspace store（单一事实源），由主进程广播 workspace:changed
    // 触发本 store 重新加载消息（见 dispatchWorkspaceChange 副作用）。
    // 本方法保留签名以兼容 useAppStore，内部只转发。
    const { useWorkspaceStore } = await import('../../useWorkspaceStore')
    await useWorkspaceStore.getState().selectSession(sessionId)
  },

  deleteSession: async (sessionId: string) => {
    // 删除会话统一走 workspace store。当前会话被删时由主进程自动切到下一条，
    // 广播 workspace:changed 后本 store 通过 dispatchWorkspaceChange 同步 messages / sessions。
    // 错误不吞：重新抛出到组件层展示（如「会话正在运行，请先停止再删除」）。
    try {
      const { useWorkspaceStore } = await import('../../useWorkspaceStore')
      await useWorkspaceStore.getState().deleteSession(sessionId)
    } catch (err) {
      console.error('删除会话出错:', err)
      throw err
    }
  },

  renameSession: async (sessionId: string, title: string) => {
    const { useWorkspaceStore } = await import('../../useWorkspaceStore')
    await useWorkspaceStore.getState().renameSession(sessionId, title)
  },

  setSessionPinned: async (sessionId: string, pinned: boolean) => {
    const { useWorkspaceStore } = await import('../../useWorkspaceStore')
    await useWorkspaceStore.getState().setSessionPinned(sessionId, pinned)
  },

  /**
   * 创建新会话（用当前项目工作区，或显式传入 workspaceRoot），
   * 统一转发到 workspace store，由主进程创建并广播。
   */
  createNewSession: async (workspaceRoot?: string) => {
    const { useWorkspaceStore } = await import('../../useWorkspaceStore')
    const ws = useWorkspaceStore.getState()
    const targetProject = workspaceRoot || ws.currentProjectPath
    if (!targetProject) return
    try {
      await ws.createSession(targetProject, ws.currentMode)
    } catch (err) {
      console.error('创建新会话失败:', err)
    }
  }
})

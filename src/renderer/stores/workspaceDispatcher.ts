/**
 * workspaceDispatcher — workspace:changed 事件的唯一副作用入口（PRD §5.1）
 *
 * 数据流（单向，无乐观更新）：
 *   UI action → useWorkspaceStore.selectXxx（转发 IPC）
 *     → 主进程 WorkspaceService 操作 → workspace:changed 广播
 *       → 本 dispatcher 把状态分发到 workspace / chat / settings / agent 四个 store
 *
 * 这是消除 split-brain 的关键：四个子 store 不再互相反向 import，
 * 而是由本模块统一在工作区变更时做必要的派生同步。
 * workspace store 的 action 发起 IPC 后不做乐观更新，统一等广播回来再分发，
 * 保证只有一个数据流方向，无双重分发歧义。
 */
import type { WorkspaceState } from '../../shared/workspace/types'
import { useWorkspaceStore } from './useWorkspaceStore'
import { useChatStore } from './useChatStore'
import { useSettingsStore } from './useSettingsStore'
import { useAgentStore } from './useAgentStore'

/** 上一次处理的 currentSessionId，用于判断是否需要 resetAgentRuntime */
let lastDispatchedSessionId: string | null | undefined = undefined
let unsubscribed = false
let unsubscribe: (() => void) | null = null

/**
 * 分发工作区状态变更到三个子 store。
 * - workspace: 更新事实源（applyWorkspaceState）
 * - chat: 同步 sessions 列表 + currentSessionId，按需重载消息
 * - settings: 同步 currentProject/currentMode 镜像
 * - agent: 会话切换时清空挂起的权限弹窗
 */
export function dispatchWorkspaceChange(state: WorkspaceState): void {
  // 0. workspace store：更新事实源（幂等）
  useWorkspaceStore.setState({ ...state, initialized: true })

  // 1. chat store：同步 sessions + currentSessionId（内部按需重载消息）
  useChatStore.getState().syncFromWorkspace({
    currentSessionId: state.currentSessionId,
    availableSessions: state.availableSessions
  })

  // 2. settings store：同步镜像（currentProject / currentMode）
  useSettingsStore.getState().syncFromWorkspace(state.currentProjectPath, state.currentMode)

  // 3. agent store：会话切换时清空挂起权限 + 重置 usage（与原 selectSession 行为一致）
  if (lastDispatchedSessionId !== state.currentSessionId) {
    useAgentStore.getState().resetAgentRuntime()
    useSettingsStore.getState().resetSessionUsage()
    lastDispatchedSessionId = state.currentSessionId
  }
}

/**
 * 启动 dispatcher：订阅 workspace:changed 事件。
 * 在 App 顶层调用一次。返回取消订阅函数。
 */
export function startWorkspaceDispatcher(): () => void {
  if (unsubscribe) return unsubscribe // 已启动，幂等

  const unsubEvent = window.api.on('workspace:changed', (data) => {
    dispatchWorkspaceChange(data.state)
  })

  unsubscribe = () => {
    if (unsubscribed) return
    unsubscribed = true
    unsubEvent()
  }
  return unsubscribe
}

/** 重置 dispatcher 内部状态。供测试使用。 */
export function resetWorkspaceDispatcherForTests(): void {
  lastDispatchedSessionId = undefined
  unsubscribed = false
  if (unsubscribe) {
    unsubscribe()
    unsubscribe = null
  }
  unsubscribed = false
}

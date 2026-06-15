/**
 * useAppStore — 兼容层
 *
 * 把 useChatStore / useAgentStore / useSettingsStore 三个 store 的状态与 actions
 * 合并成与原 useAppStore 相同的形状，让现有组件可以零改动继续工作。
 *
 * 架构方向：
 * - 三个子 store 是 source of truth
 * - useAppStore 通过订阅三个子 store 派生合并视图
 * - setState 自动按字段归属分发到对应子 store
 *
 * 后续组件应逐步改为直接导入 useChatStore / useAgentStore / useSettingsStore，
 * 本兼容层只用于过渡期，不推荐新增调用方。
 */
import { useMemo } from 'react'
import { useChatStore } from './useChatStore'
import { useAgentStore } from './useAgentStore'
import { useSettingsStore } from './useSettingsStore'
import { selectSupportsVisionFromConfig } from './selectors'
import type {
  ExtendedMessage,
  ExtendedToolCall,
  RendererMessageBlock,
  RendererToolBlock,
  PendingPermissionRequest,
  MessageDiffCache,
  SessionUsageStats
} from './types'
import type {
  Session,
  Mode,
  PermissionDecision
} from '../../shared/session/types'
import type { ModelConfig } from '../../shared/config'
import type { DiffEntry, DiffReviewStatus } from '../../shared/diff/types'
import type { NormalizedUsage } from '../../runtime/model/types'
import type { ImageAttachment } from '../lib/image-attachments'

/** 与旧 useAppStore 形状完全一致的合并 state，供 selector 与组件使用 */
export interface AppState {
  // ── settings ──
  currentProject: string | null
  currentMode: Mode
  modelConfig: ModelConfig | null
  contextLimit: number
  isConfigModalOpen: boolean
  sessionUsage: SessionUsageStats | null
  contextBreakdown: import('./useSettingsStore').ContextBreakdown | null
  // ── chat ──
  sessions: Session[]
  currentSessionId: string | null
  messages: ExtendedMessage[]
  messageIndexById: Record<string, number>
  isGenerating: boolean
  currentGeneratingMessageId: string | null
  messageDiffs: Record<string, MessageDiffCache>
  loadingDiffs: Set<string>
  loadingDiffPlaceholders: Record<string, Array<{ filePath: string; status: DiffEntry['status'] }>>
  streamingToolArgs: Record<string, string>
  // ── agent ──
  pendingPermissionRequest: PendingPermissionRequest | null
  isSubmittingPermission: boolean
  permissionError: string | null
  pendingVerificationRequest: { requestId: string; command: string } | null
  /** Phase 6：Steering Queue */
  pendingUserMessages: Array<{ text: string; images: import('../lib/image-attachments').ImageAttachment[] }>
  // ── actions ──
  selectProject: () => Promise<void>
  setMode: (mode: Mode) => Promise<void>
  sendMessage: (content: string, images?: ImageAttachment[]) => Promise<void>
  cancelExecution: () => Promise<void>
  loadModelConfig: () => Promise<void>
  saveModelConfig: (config: ModelConfig) => Promise<void>
  setConfigModalOpen: (isOpen: boolean) => void
  loadSessions: () => Promise<void>
  selectSession: (sessionId: string) => Promise<void>
  deleteSession: (sessionId: string) => Promise<void>
  createNewSession: (workspaceRoot?: string) => Promise<void>
  rollbackMessage: (sessionId: string, messageId: string) => Promise<void>
  rejectFile: (sessionId: string, messageId: string, filePath: string) => Promise<void>
  loadMessageDiffs: (sessionId: string, messageId: string) => Promise<void>
  acceptFile: (sessionId: string, messageId: string, filePath: string) => Promise<void>
  clearMessageDiffs: (messageId: string) => void
  handleMessageStart: (messageId: string) => void
  /**
   * @deprecated 自 Phase 2 引入 streamDeltaBuffer + applyStreamDeltas 批量路径后，
   * 生产代码已不再直接调用此 handler。保留仅为向后兼容与单元测试。
   * 未来版本会移除；新代码请改用 `applyStreamDeltas`（buffer 在 App 端直接喂批量 delta）。
   */
  handleThinkingDelta: (messageId: string, delta: string) => void
  /**
   * @deprecated 同 handleThinkingDelta。新代码请改用 `applyStreamDeltas`。
   */
  handleTextDelta: (messageId: string, delta: string) => void
  handleToolCallStart: (messageId: string, toolCallId: string, toolName: string) => void
  /**
   * @deprecated 同 handleThinkingDelta。新代码请改用 `applyStreamDeltas`（kind: 'toolCall'）。
   */
  handleToolCallDelta: (messageId: string, toolCallId: string, argumentsDelta: string) => void
  /**
   * 仍是主进程 tool_call 终态事件（不含 streaming）的合法处理入口；
   * 不是被 buffer/scheduler 替代的对象。保留为长期 API。
   */
  handleToolCall: (messageId: string, toolCallId: string, toolName: string, args: Record<string, unknown>) => void
  handleToolResult: (messageId: string, toolCallId: string, toolName: string, result: string) => void
  handleDiffUpdate: (
    messageId: string,
    phase: 'live' | 'final',
    diffs: Array<{ filePath: string; status: DiffEntry['status']; hunks?: DiffEntry['hunks'] }>,
    reviews: Record<string, DiffReviewStatus>
  ) => void
  handleMessageEnd: (messageId: string, interrupted?: boolean) => void
  handleUsage: (usage: NormalizedUsage) => void
  setContextBreakdown: (payload: import('./useSettingsStore').ContextBreakdown) => void
  handleError: (messageId: string, error: string) => void
  handleVerificationResult: (messageId: string, result: string) => void
  handlePermissionRequest: (request: PendingPermissionRequest) => void
  respondPermissionRequest: (decision: PermissionDecision) => Promise<void>
  handleVerificationPermissionRequest: (request: { requestId: string; command: string }) => void
  clearVerificationPermissionRequest: (requestId: string) => void
  respondVerificationPermission: (granted: boolean) => void
  /** Phase 2 批量 delta 入口（外部组件不直接调用，由 IPC listener 调用） */
  applyStreamDeltas: (deltas: import('./useChatStore').StreamDeltaBatch) => void
  /** Phase 6：入队一条挂起消息（Agent 运行期间用户输入） */
  enqueuePendingMessage: (text: string, images: import('../lib/image-attachments').ImageAttachment[]) => void
  /** Phase 6：移除一条挂起消息（按索引） */
  removePendingMessage: (index: number) => void
  /** Phase 6：清空全部挂起消息 */
  clearPendingMessages: () => void
}

/** 把三个 store 的 state 合并成单一 AppState（不含 actions，因为 actions 走 getState()） */
function mergeState(
  chat: ReturnType<typeof useChatStore.getState>,
  agent: ReturnType<typeof useAgentStore.getState>,
  settings: ReturnType<typeof useSettingsStore.getState>
): AppState {
  return {
    // settings
    currentProject: settings.currentProject,
    currentMode: settings.currentMode,
    modelConfig: settings.modelConfig,
    contextLimit: settings.contextLimit,
    isConfigModalOpen: settings.isConfigModalOpen,
    sessionUsage: settings.sessionUsage,
    contextBreakdown: settings.contextBreakdown,
    // chat
    sessions: chat.sessions,
    currentSessionId: chat.currentSessionId,
    messages: chat.messages,
    messageIndexById: chat.messageIndexById,
    isGenerating: chat.isGenerating,
    currentGeneratingMessageId: chat.currentGeneratingMessageId,
    messageDiffs: chat.messageDiffs,
    loadingDiffs: chat.loadingDiffs,
    loadingDiffPlaceholders: chat.loadingDiffPlaceholders,
    streamingToolArgs: chat.streamingToolArgs,
    // agent
  pendingPermissionRequest: agent.pendingPermissionRequest,
  isSubmittingPermission: agent.isSubmittingPermission,
  permissionError: agent.permissionError,
  pendingVerificationRequest: agent.pendingVerificationRequest,
  pendingUserMessages: chat.pendingUserMessages,
    // actions（按子 store 转发）
    selectProject: settings.selectProject,
    setMode: settings.setMode,
    sendMessage: chat.sendMessage,
    cancelExecution: agent.cancelExecution,
    loadModelConfig: settings.loadModelConfig,
    saveModelConfig: settings.saveModelConfig,
    setConfigModalOpen: settings.setConfigModalOpen,
    loadSessions: chat.loadSessions,
    selectSession: chat.selectSession,
    deleteSession: chat.deleteSession,
    createNewSession: chat.createNewSession,
    rollbackMessage: chat.rollbackMessage,
    rejectFile: chat.rejectFile,
    loadMessageDiffs: chat.loadMessageDiffs,
    acceptFile: chat.acceptFile,
    clearMessageDiffs: chat.clearMessageDiffs,
    handleMessageStart: chat.handleMessageStart,
    handleThinkingDelta: chat.handleThinkingDelta,
    handleTextDelta: chat.handleTextDelta,
    handleToolCallStart: chat.handleToolCallStart,
    handleToolCallDelta: chat.handleToolCallDelta,
    handleToolCall: chat.handleToolCall,
    handleToolResult: chat.handleToolResult,
    handleDiffUpdate: chat.handleDiffUpdate,
    handleMessageEnd: chat.handleMessageEnd,
    handleUsage: settings.handleUsage,
    setContextBreakdown: settings.setContextBreakdown,
    handleError: chat.handleError,
    handleVerificationResult: chat.handleVerificationResult,
    handlePermissionRequest: agent.handlePermissionRequest,
    respondPermissionRequest: agent.respondPermissionRequest,
  handleVerificationPermissionRequest: agent.handleVerificationPermissionRequest,
  clearVerificationPermissionRequest: agent.clearVerificationPermissionRequest,
  respondVerificationPermission: agent.respondVerificationPermission,
  applyStreamDeltas: chat.applyStreamDeltas,
  // Phase 6：Steering Queue
  enqueuePendingMessage: chat.enqueuePendingMessage,
  removePendingMessage: chat.removePendingMessage,
  clearPendingMessages: chat.clearPendingMessages
}
}

/** setState 字段归属映射：每个 key 归属的子 store
 * 改用 Record<keyof AppState, ...> 而非裸对象，确保新增 key 时 TypeScript 报错
 * （避免拼写错误或遗漏导致分发到错误子 store）。但允许 owner 字段为 undefined
 * （用于不归任何子 store 的纯派生字段，此处用 '_' 标记并跳过分发）。
 */
type Owner = 'chat' | 'agent' | 'settings' | '_'
const KEY_OWNERSHIP: Record<keyof AppState, Owner> = {
  // settings
  currentProject: 'settings',
  currentMode: 'settings',
  modelConfig: 'settings',
  contextLimit: 'settings',
  isConfigModalOpen: 'settings',
  sessionUsage: 'settings',
  contextBreakdown: 'settings',
  // chat
  sessions: 'chat',
  currentSessionId: 'chat',
  messages: 'chat',
  messageIndexById: 'chat',
  isGenerating: 'chat',
  currentGeneratingMessageId: 'chat',
  messageDiffs: 'chat',
  loadingDiffs: 'chat',
  loadingDiffPlaceholders: 'chat',
  streamingToolArgs: 'chat',
  // agent
  pendingPermissionRequest: 'agent',
  isSubmittingPermission: 'agent',
  permissionError: 'agent',
  pendingVerificationRequest: 'agent',
  pendingUserMessages: 'chat',
  // actions are read-only references, never set via setState
  selectProject: 'settings',
  setMode: 'settings',
  sendMessage: 'chat',
  cancelExecution: 'agent',
  loadModelConfig: 'settings',
  saveModelConfig: 'settings',
  setConfigModalOpen: 'settings',
  loadSessions: 'chat',
  selectSession: 'chat',
  deleteSession: 'chat',
  createNewSession: 'chat',
  rollbackMessage: 'chat',
  rejectFile: 'chat',
  loadMessageDiffs: 'chat',
  acceptFile: 'chat',
  clearMessageDiffs: 'chat',
  handleMessageStart: 'chat',
  handleThinkingDelta: 'chat',
  handleTextDelta: 'chat',
  handleToolCallStart: 'chat',
  handleToolCallDelta: 'chat',
  handleToolCall: 'chat',
  handleToolResult: 'chat',
  handleDiffUpdate: 'chat',
  handleMessageEnd: 'chat',
  handleUsage: 'settings',
  setContextBreakdown: 'settings',
  handleError: 'chat',
  handleVerificationResult: 'chat',
  handlePermissionRequest: 'agent',
  respondPermissionRequest: 'agent',
  handleVerificationPermissionRequest: 'agent',
  clearVerificationPermissionRequest: 'agent',
  respondVerificationPermission: 'agent',
  applyStreamDeltas: 'chat',
  enqueuePendingMessage: 'chat',
  removePendingMessage: 'chat',
  clearPendingMessages: 'chat'
}

/**
 * useAppStore — 兼容旧 API 的合并 hook + 静态 API
 *
 * 用法：
 * - `useAppStore(state => state.x)`：hook 形式
 * - `useAppStore.getState()`：读取合并状态
 * - `useAppStore.setState(partial)`：把 partial 按字段归属分发到三个子 store
 * - `useAppStore.subscribe(listener)`：订阅任一子 store 变化
 */
function useAppStoreImpl(): AppState
function useAppStoreImpl<T>(selector: (state: AppState) => T): T
function useAppStoreImpl<T>(selector?: (state: AppState) => T): T | AppState {
  // 订阅三个子 store（zustand 的 useStore 无 selector 时返回整个 state）
  // 使用 React.useSyncExternalStore 风格：每个子 store 都订阅以触发重渲染
  const chatState = useChatStore()
  const agentState = useAgentStore()
  const settingsState = useSettingsStore()

  const merged = useMemo(
    () => mergeState(chatState, agentState, settingsState),
    [chatState, agentState, settingsState]
  )

  if (selector) {
    return selector(merged)
  }
  return merged
}

/** 静态 API：getState / setState / subscribe */
const useAppStoreStatic = useAppStoreImpl as unknown as {
  <T>(selector: (state: AppState) => T): T
  (): AppState
  getState: () => AppState
  setState: (partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void
  subscribe: (listener: (state: AppState, prevState: AppState) => void) => () => void
}

useAppStoreStatic.getState = () => mergeState(
  useChatStore.getState(),
  useAgentStore.getState(),
  useSettingsStore.getState()
)

useAppStoreStatic.setState = (partial) => {
  const resolved = typeof partial === 'function'
    ? partial(useAppStoreStatic.getState())
    : partial

  const chatPatch: Record<string, unknown> = {}
  const agentPatch: Record<string, unknown> = {}
  const settingsPatch: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(resolved)) {
    const owner = KEY_OWNERSHIP[key as keyof AppState]
    if (owner === 'chat') chatPatch[key] = value
    else if (owner === 'agent') agentPatch[key] = value
    else if (owner === 'settings') settingsPatch[key] = value
    // owner === '_' 视为派生 / 内部字段，setState 不分发到任何子 store
  }

  // 子 store setState 接受 Partial<...>，但因为我们是从合并视图切片得到的，
  // 类型对不上（合并视图字段多于子 store 字段），用类型断言绕过。
  // 这是 zustand 多 store 合并层的固有限制：合并视图 ≠ 子 store 视图。
  if (Object.keys(chatPatch).length > 0) {
    useChatStore.setState(chatPatch as Partial<ReturnType<typeof useChatStore.getState>>)
  }
  if (Object.keys(agentPatch).length > 0) {
    useAgentStore.setState(agentPatch as Partial<ReturnType<typeof useAgentStore.getState>>)
  }
  if (Object.keys(settingsPatch).length > 0) {
    useSettingsStore.setState(settingsPatch as Partial<ReturnType<typeof useSettingsStore.getState>>)
  }
}

/**
 * 订阅合并状态变化。返回取消订阅函数。
 * 当任一子 store 状态变化时触发 listener（合并后状态对比）。
 */
useAppStoreStatic.subscribe = (listener) => {
  let prevMerged = useAppStoreStatic.getState()
  const sub = (): void => {
    const nextMerged = useAppStoreStatic.getState()
    if (nextMerged === prevMerged) return
    const prev = prevMerged
    prevMerged = nextMerged
    listener(nextMerged, prev)
  }
  const unsubChat = useChatStore.subscribe(sub)
  const unsubAgent = useAgentStore.subscribe(sub)
  const unsubSettings = useSettingsStore.subscribe(sub)
  return () => {
    unsubChat()
    unsubAgent()
    unsubSettings()
  }
}

export const useAppStore = useAppStoreStatic

// 重新导出关键类型与跨 store selector，保持与旧模块相同的导出面
export type { ExtendedMessage, ExtendedToolCall, RendererMessageBlock, RendererToolBlock }

/** 与旧 useAppStore 同名的跨 store selector：当前模型是否支持图片输入 */
export const selectSupportsVision = (state: AppState): boolean =>
  selectSupportsVisionFromConfig(state.modelConfig)

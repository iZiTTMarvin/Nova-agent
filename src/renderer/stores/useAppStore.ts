/**
 * useAppStore — 非 React 静态 facade（阶段 6 / T6-2）
 *
 * React 合并订阅已删除：当作 hook 调用会抛错。
 * 生产组件必须直接用 useChatStore / useAgentStore / useSettingsStore（带 selector）。
 *
 * 本模块仅保留 getState / setState / subscribe 合并视图，供尚未迁完的单测使用；
 * 新测试请直接操作子 store。
 */
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

/** 与旧 useAppStore 形状完全一致的合并 state，供 getState / 测试使用 */
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
  renameSession: (sessionId: string, title: string) => Promise<void>
  createNewSession: (workspaceRoot?: string) => Promise<void>
  regenerateAssistant: (sessionId: string, messageId: string) => Promise<void>
  switchBranch: (sessionId: string, targetMessageId: string) => Promise<void>
  editResend: (sessionId: string, messageId: string, newContent: string) => Promise<void>
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

/** 把三个 store 的 state 合并成单一 AppState */
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
    renameSession: chat.renameSession,
    createNewSession: chat.createNewSession,
    regenerateAssistant: chat.regenerateAssistant,
    switchBranch: chat.switchBranch,
    editResend: chat.editResend,
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
    enqueuePendingMessage: chat.enqueuePendingMessage,
    removePendingMessage: chat.removePendingMessage,
    clearPendingMessages: chat.clearPendingMessages
  }
}

/** setState 字段归属映射：每个 key 归属的子 store */
type Owner = 'chat' | 'agent' | 'settings' | '_'
const KEY_OWNERSHIP: Record<keyof AppState, Owner> = {
  currentProject: 'settings',
  currentMode: 'settings',
  modelConfig: 'settings',
  contextLimit: 'settings',
  isConfigModalOpen: 'settings',
  sessionUsage: 'settings',
  contextBreakdown: 'settings',
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
  pendingPermissionRequest: 'agent',
  isSubmittingPermission: 'agent',
  permissionError: 'agent',
  pendingVerificationRequest: 'agent',
  pendingUserMessages: 'chat',
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
  renameSession: 'chat',
  createNewSession: 'chat',
  regenerateAssistant: 'chat',
  switchBranch: 'chat',
  editResend: 'chat',
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
 * 非 React facade：仅 getState / setState / subscribe。
 * 若误当作 React hook 调用，会抛错，强制改用子 store selector。
 */
function useAppStoreHookGuard(): never {
  throw new Error(
    '[useAppStore] 已移除 React 合并订阅。请直接使用 useChatStore / useAgentStore / useSettingsStore（带 selector）。'
  )
}

const useAppStoreStatic = useAppStoreHookGuard as unknown as {
  (): never
  <T>(_selector: (state: AppState) => T): never
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
  }

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
 * 当任一子 store 状态变化时触发 listener。
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

export type { ExtendedMessage, ExtendedToolCall, RendererMessageBlock, RendererToolBlock }

/** 与旧 useAppStore 同名的跨 store selector：当前模型是否支持图片输入 */
export const selectSupportsVision = (state: AppState): boolean =>
  selectSupportsVisionFromConfig(state.modelConfig)

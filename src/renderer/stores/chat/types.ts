/**
 * chat store 对外契约：ChatState 形状、流式 delta 批量结构与 slice 创建器类型。
 * 字段名、类型与 action 签名是 useAppStore facade 与全部组件 selector 的依赖面，
 * 修改前必须同步 chatStoreShape 护栏测试。
 */
import type { StateCreator } from 'zustand'
import type { Session } from '../../../shared/session/types'
import type { DiffEntry, DiffReviewStatus } from '../../../shared/diff/types'
import type { Tier1BranchContext } from '../../../shared/workspace/types'
import type { HookEvent } from '../../../shared/agent/types'
import type { RendererRecoveryState } from '../../../shared/ipc/types'
import type { ImageAttachment } from '../../lib/image-attachments'
import type {
  ExtendedMessage,
  ExtendedToolCall,
  LiveBlock,
  MessageDiffCache,
  RendererMessageBlock,
  RendererToolBlock,
  SessionMessagePayload
} from '../types'

export type {
  ExtendedMessage,
  ExtendedToolCall,
  LiveBlock,
  MessageDiffCache,
  RendererMessageBlock,
  RendererToolBlock,
  SessionMessagePayload
}

// ── 流式 delta 批量结构 ──────────────────────────────

/** 单条 delta 的统一结构（thinking / text / toolCall 三选一） */
export type StreamDelta =
  | { kind: 'thinking'; messageId: string; delta: string }
  | { kind: 'text'; messageId: string; delta: string }
  | { kind: 'toolCall'; messageId: string; toolCallId: string; delta: string }

/** 一次 flush 的批量 delta 数组 */
export type StreamDeltaBatch = StreamDelta[]

/** messageSlice 拥有的状态形状：消息列表与 id → 数组索引。 */
export interface MessageSliceState {
  messages: ExtendedMessage[]
  /** id → 数组索引，用于 delta handler O(1) 定位 */
  messageIndexById: Record<string, number>
}

/**
 * liveTurnSlice 拥有的活跃回合集：messageId → 当前未封存的尾部块（text / thinking）。
 * 流式 text/thinking delta 只写这里，不触碰 messages 数组，使 messages 在流式期间
 * 引用稳定，避免 ChatPanel 顶层每秒提交数十次。工具边界、类型切换或轮次终态时由
 * owner 把活跃块折叠（fold）回 messages。
 */
export interface LiveTurnSliceState {
  liveTurn: Record<string, LiveBlock>
}

/** streamSlice 拥有的状态与流式事件 action。 */
export interface StreamSliceState {
  /**
   * 流式工具调用参数累积：toolCallId → 已累积的 arguments 字符串。
   * start 时初始化为空字符串，delta 追加片段，最终 tool_call 事件到达后清空。
   */
  streamingToolArgs: Record<string, string>

  /**
   * 批量应用流式 delta：
   * 把同帧累积的 delta 按 messageId 分组合并，一次 set() 写回 store。
   * 接受三种 delta 类型：thinking / text / toolCall。
   */
  applyStreamDeltas: (deltas: StreamDeltaBatch) => void
  handleMessageStart: (messageId: string) => void
  /**
   * 某次模型 attempt 失败：丢掉末尾未完成输出，保留已完成工具轮次。
   */
  handleAttemptFailed: (messageId: string, attemptId: string) => void
  /**
   * @deprecated 自引入 streamDeltaBuffer + applyStreamDeltas 批量路径后，
   * 生产代码已不再直接调用此 handler。保留仅为向后兼容与单元测试。
   * 未来版本会移除；新代码请改用 `applyStreamDeltas`（buffer 在 App 端直接喂批量 delta）。
   */
  handleThinkingDelta: (messageId: string, delta: string) => void
  /** @deprecated 同 handleThinkingDelta。新代码请改用 `applyStreamDeltas`。 */
  handleTextDelta: (messageId: string, delta: string) => void
  handleToolCallStart: (messageId: string, toolCallId: string, toolName: string) => void
  /**
   * @deprecated 同 handleThinkingDelta。新代码请改用 `applyStreamDeltas`（kind: 'toolCall'）。
   */
  handleToolCallDelta: (messageId: string, toolCallId: string, argumentsDelta: string) => void
  /**
   * @deprecated 仍是主进程 tool_call 终态事件（不含 streaming）的合法处理入口；
   * 不是被 buffer/scheduler 替代的对象。保留为长期 API。
   * 嵌套调用（run_code 沙箱内）携带 parentToolCallId：不创建顶级工具块，
   * 只记入父工具块的紧凑活动列表。
   */
  handleToolCall: (
    messageId: string,
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
    parentToolCallId?: string
  ) => void
  handleToolResult: (
    messageId: string,
    toolCallId: string,
    toolName: string,
    result: string,
    parentToolCallId?: string
  ) => void
}

/** recoverySlice 拥有的恢复态簿记字段与事件 handler。 */
export interface RecoverySliceState {
  /** 每条消息当前的恢复状态（retrying / recovering 等） */
  recoveryState: Record<string, RendererRecoveryState>
  /** 每条消息累积的恢复提示（按到达顺序追加） */
  recoveryHints: Record<string, Array<{ hint: string; attempt: number }>>
  /** 每条消息累积的 Hook 执行异常 */
  hookErrors: Record<string, Array<{ hookEvent: HookEvent; error: string }>>

  /** 主进程 recovery_state 事件：更新当前消息的恢复状态机 */
  handleRecoveryState: (messageId: string, state: RendererRecoveryState) => void
  /** 主进程 recovery_hint 事件：追加一条恢复提示 */
  handleRecoveryHint: (messageId: string, hint: string, attempt: number) => void
  /** 主进程 hook_error 事件：记录 Hook 执行异常（不中断 Agent） */
  handleHookError: (messageId: string, hookEvent: HookEvent, error: string) => void
}

/** turnLifecycleSlice 拥有的轮次运行态与终态 handler。 */
export interface TurnLifecycleSliceState {
  /** 与消息生成生命周期强绑定，写入由 sendMessage / handleMessageStart / handleError 触发 */
  isGenerating: boolean
  currentGeneratingMessageId: string | null
  /** 当前 Agent 轮次归属的会话 ID（切走后用于过滤旧会话事件） */
  activeAgentSessionId: string | null

  /**
   * 主进程消息结束事件。
   * @param messageId 消息 ID
   * @param interrupted 是否为 cancel 中断结束
   *
   * 声明为 async 以便 await turn boundary 的挂起消息派发，
   * 调用方拿到 Promise resolve 时 store 状态已稳定（pending 已 dispatch）。
   */
  handleMessageEnd: (messageId: string, interrupted?: boolean) => Promise<void>
  handleError: (messageId: string, error: string) => Promise<void>

  /**
   * 把当前所有 running tool 块标记为 error（"用户取消执行"）。
   * 由 useAgentStore.cancelExecution 触发，保留旧 useAppStore 的兜底行为。
   */
  markRunningAsCancelled: () => void
}

/** sessionSlice 拥有的会话列表与当前会话，及会话 CRUD。 */
export interface SessionSliceState {
  sessions: Session[]
  currentSessionId: string | null
  /** 当前选中子会话的持久化原始任务；普通会话或尚未水合时为 null。 */
  currentSubagentTask: string | null

  /** 加载会话列表 */
  loadSessions: () => Promise<void>
  /** 选中指定会话并加载消息 */
  selectSession: (sessionId: string) => Promise<void>
  /** 删除会话（当前会话被删时切到下一条或清空） */
  deleteSession: (sessionId: string) => Promise<void>
  /** 重命名会话标题 */
  renameSession: (sessionId: string, title: string) => Promise<void>
  /** 设置会话置顶标记（侧边栏置顶分区） */
  setSessionPinned: (sessionId: string, pinned: boolean) => Promise<void>
  /** 创建新会话 */
  createNewSession: (workspaceRoot?: string) => Promise<void>
}

/** sendSlice 拥有的发送状态与 steering 队列。 */
export interface SendSliceState {
  /** 发送请求已发出、尚未收到首个流式事件（防连点） */
  sendInFlight: boolean
  /**
   * Steering Queue 等待派发的用户消息。
   * Agent 运行期间用户仍可输入，输入的消息会进入此队列，
   * 在 turn boundary（handleMessageEnd / cancel 完成）自动 dispatch。
   */
  pendingUserMessages: Array<{ text: string; images: ImageAttachment[]; autoMode?: boolean }>

  /** 发送用户消息（含图片）。返回 false 表示被守卫拦截未发出。 */
  sendMessage: (
    content: string,
    images?: ImageAttachment[],
    options?: {
      rollbackSnapshot?: { messages: ExtendedMessage[]; messageIndexById: Record<string, number> }
      autoMode?: boolean
    }
  ) => Promise<boolean>
  /**
   * Steering Queue — 用户在 Agent 运行期间入队消息
   * 实际 dispatch 在 turn boundary 触发（handleMessageEnd / markRunningAsCancelled 后）
   */
  enqueuePendingMessage: (text: string, images: ImageAttachment[], autoMode?: boolean) => void
  /** 取消某条挂起消息的排队（按索引） */
  removePendingMessage: (index: number) => void
  /** 清空全部挂起消息 */
  clearPendingMessages: () => void
}

/** branchSlice 拥有的会话树分叉状态与分支操作。 */
export interface BranchSliceState {
  /**
   * 编辑/重新生成分叉后，待本轮流式结束再 bump messagesRevision，
   * 以便 load-session 下发 branch 元信息（翻页器可见）。
   */
  pendingBranchMetaReload: boolean
  /** prepare 与 send-message 之间的短窗口：禁止 switchBranch */
  branchForkInProgress: boolean
  /** Tier 1 切分支后的提示与 diff 灰显上下文（来自 WorkspaceState） */
  tier1BranchContext: Tier1BranchContext | null

  /** 按消息回退到某条消息之前的状态 */
  regenerateAssistant: (sessionId: string, messageId: string) => Promise<void>
  /** 切换到兄弟分支（翻页器） */
  switchBranch: (sessionId: string, targetMessageId: string) => Promise<void>
  /** 编辑某条用户消息并重发：分叉手术 + 乐观截断 + 复用流式发送 */
  editResend: (sessionId: string, messageId: string, newContent: string) => Promise<void>
  /**
   * 分叉轮次结束后 bump revision，拉取 branch 元信息；或 send 失败时强制与主进程对齐。
   */
  finishBranchMetaRefresh: () => Promise<void>
  /** 用户关闭 Tier 1 横幅 */
  dismissTier1BranchNotice: () => void
}

/** diffSlice 拥有的 diff 投影、review 状态与公开 action。 */
export interface DiffSliceState {
  /** 每条消息的 diff 数据缓存 */
  messageDiffs: Record<string, MessageDiffCache>
  /** 正在加载 diff 的消息 ID 集合 */
  loadingDiffs: Set<string>
  /**
   * live 阶段的占位文件列表，仅在等待最终 diff 数据时使用。
   * 让 DiffViewer 在 skeleton 状态下也能展示文件名。
   */
  loadingDiffPlaceholders: Record<string, Array<{ filePath: string; status: DiffEntry['status'] }>>
  /** 每条消息回滚失败的错误提示（key 为 messageId） */
  rollbackErrors: Record<string, string>

  /** 按文件接受改动 */
  acceptFile: (sessionId: string, messageId: string, filePath: string) => Promise<void>
  /** 按文件拒绝改动 */
  rejectFile: (sessionId: string, messageId: string, filePath: string) => Promise<void>
  /** 批量接受多个文件改动 */
  acceptAllFiles: (sessionId: string, messageId: string, filePaths: string[]) => Promise<void>
  /** 批量拒绝多个文件改动，返回恢复成功与失败的文件 */
  rejectAllFiles: (sessionId: string, messageId: string, filePaths: string[]) => Promise<{ restored: string[]; failed: Array<{ filePath: string; error: string }> }>
  /** 加载某条消息的 diff 数据 */
  loadMessageDiffs: (sessionId: string, messageId: string) => Promise<void>
  /** 清除指定消息的 diff 缓存（拒绝后刷新用） */
  clearMessageDiffs: (messageId: string) => void
  handleDiffUpdate: (
    messageId: string,
    phase: 'live' | 'final',
    diffs: Array<{ filePath: string; status: DiffEntry['status']; hunks?: DiffEntry['hunks'] }>,
    reviews: Record<string, DiffReviewStatus>
  ) => void
}

/** paginationSlice 拥有的消息视窗游标与上滚补载 action。 */
export interface PaginationSliceState {
  /** 当前视窗顶部之前是否还有更早消息（可上滚补载） */
  hasMoreMessagesAbove: boolean
  /** 上滚补载进行中，防重入 */
  isLoadingOlderMessages: boolean
  /** 当前视窗内最早一条消息的 id，作为下次 beforeId 游标 */
  oldestLoadedMessageId: string | null
  /**
   * 用户已向上翻历史并 prepend 过时为 true，暂停 trimMessageWindow 头部裁剪。
   * 避免 prepend 的早期消息被流式 trim 立刻弹走。切换会话 / 回退重载时重置。
   * 未上滚时若流式累计触发头部裁剪，游标由 paginationPatchAfterHeadTrim 同步到新窗口首条。
   */
  suspendHeadTrim: boolean

  /** 上滚到顶时加载更早一页消息并 prepend 到视窗 */
  loadOlderMessages: () => Promise<void>
}

/** workspaceSyncSlice 拥有 workspace 广播同步与会话水合生命周期。 */
export interface WorkspaceSyncSliceState {
  /**
   * 上次 syncFromWorkspace 见到的 messagesRevision。
   * 用于检测「同会话内消息序列变化」（回退/切分支），据此绕过 sessionChanged 守卫重拉消息。
   */
  lastMessagesRevision: number

  /**
   * 把 workspace store 广播的工作区状态同步到本 store。
   * 由 workspaceDispatcher 调用（workspace:changed 事件的唯一副作用入口）。
   * @internal 不应被 UI 组件直接调用
   */
  syncFromWorkspace: (next: {
    currentSessionId: string | null
    availableSessions: Session[]
    /** 同会话内消息序列版本号；与上次不同则强制重拉消息（回退/切分支用，绕过 sessionChanged 守卫） */
    messagesRevision: number
    tier1BranchContext: Tier1BranchContext | null
  }) => void
}

export interface ChatState
  extends
    MessageSliceState,
    LiveTurnSliceState,
    StreamSliceState,
    RecoverySliceState,
    TurnLifecycleSliceState,
    SessionSliceState,
    SendSliceState,
    BranchSliceState,
    DiffSliceState,
    PaginationSliceState,
    WorkspaceSyncSliceState {}

/** slice 创建器统一别名：所有 slice 共享同一个 ChatState 组合形状 */
export type ChatSliceCreator<TSlice> = StateCreator<ChatState, [], [], TSlice>

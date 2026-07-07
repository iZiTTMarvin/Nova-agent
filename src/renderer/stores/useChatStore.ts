/**
 * useChatStore — 消息、会话、消息索引、Diff 缓存、流式事件 handler
 *
 * 负责：
 * - 会话列表与当前会话
 * - 消息列表 + 消息索引
 * - 当前正在生成的消息 ID + isGenerating（与消息生命周期强绑定）
 * - 流式工具调用参数累积
 * - 每条消息的 diff 缓存（live / final、loading 状态）
 * - 来自主进程的所有 delta/事件 handler
 *
 * 依赖方向：
 * - 可以读 useAgentStore / useSettingsStore（通过 getState）
 * - 不被 useAgentStore 内部状态依赖（cancel 路径从 agent store 进入后调本 store）
 */
import { create } from 'zustand'
import type {
  Session,
  SessionDetail,
  MessageBlock,
  Mode,
  PermissionDecision
} from '../../shared/session/types'
import { SESSION_HISTORY_PAGE_SIZE } from '../../shared/session/messagePagination'
import type { DiffEntry, DiffReviewStatus } from '../../shared/diff/types'
import type { Tier1BranchContext } from '../../shared/workspace/types'
import type { NormalizedUsage } from '../../runtime/model/types'
import type { HookEvent } from '../../runtime/agent/types'
import type { RendererRecoveryState } from '../../shared/ipc/types'
import { stripTextToolCalls } from '../../shared/tool-call-text-fallback'
import { stripMinimaxArtifacts } from '../../runtime/agent/stream/xmlToolScanner'
import type { ImageAttachment } from '../lib/image-attachments'
import { parsePartialToolArgs } from '../features/chat/partialJsonArgs'
import { sanitizeToolInput, sanitizeToolOutput } from '../../shared/tool-input-sanitizer'
import type {
  ExtendedMessage,
  ExtendedToolCall,
  MessageDiffCache,
  PendingPermissionRequest,
  RendererMessageBlock,
  RendererToolBlock,
  SessionMessagePayload
} from './types'

// ── 内部辅助函数（与 useAppStore 旧实现行为完全一致） ─────────────────

/** 根据 tool_result 文本判断工具调用是否失败（与 runtime 文案协议） */
function getToolCallStatus(result?: string): ExtendedToolCall['status'] {
  if (!result) return 'success'
  return result.startsWith('工具执行失败') || result.startsWith('权限拒绝:')
    ? 'error'
    : 'success'
}

/** 旧会话兼容路径：剥离历史 <think>...</think> 标签，不在 UI 重复展示 */
function stripLegacyThinkingTags(content: string): string {
  return content.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<think>[\s\S]*$/g, '')
}

/**
 * 某些模型会把工具调用误输出成正文里的 JSON / XML 片段。
 * 当后端随后补发真实 tool_call 事件时，这里把那段伪调用从消息文本里剥掉，
 * 避免界面同时出现“黑色 JSON 代码块 / XML + 真实工具卡片”的重复展示。
 */
function stripInlinePseudoToolCalls(
  content: string,
  blocks: RendererMessageBlock[]
): { content: string; blocks: RendererMessageBlock[] } {
  let cleanedContent = stripMinimaxArtifacts(content)
  cleanedContent = stripTextToolCalls(cleanedContent)
  if (cleanedContent === content) {
    return { content, blocks }
  }

  const nextBlocks = [...blocks]
  for (let i = nextBlocks.length - 1; i >= 0; i--) {
    const block = nextBlocks[i]
    if (block.type !== 'text') continue

    let cleanedBlockText = stripMinimaxArtifacts(block.content)
    cleanedBlockText = stripTextToolCalls(cleanedBlockText)
    if (cleanedBlockText === block.content) break

    if (cleanedBlockText.length === 0) {
      nextBlocks.splice(i, 1)
    } else {
      nextBlocks[i] = { ...block, content: cleanedBlockText }
    }
    break
  }

  return { content: cleanedContent, blocks: nextBlocks }
}

/** 把后端返回的 SessionDetail 消息列表恢复成 ExtendedMessage 数组 */
function restoreSessionMessages(messages: SessionDetail['messages']): ExtendedMessage[] {
  return messages.map((message) => {
    const payload = message as SessionMessagePayload
    const results = payload._toolCallResults ?? {}
    const sanitizedContent = stripLegacyThinkingTags(message.content)

    const toolCalls = message.toolCalls?.map((toolCall) => {
      const result = results[toolCall.id]
      // T01：历史消息恢复时对 write/edit 工具的 arguments 做摘要化
      const sanitizedArgs = sanitizeToolInput(toolCall.name, toolCall.arguments)
      // T02：对工具输出做截断，防止历史消息中的长 result 撑爆 heap
      const isErr = result?.startsWith('工具执行失败') || result?.startsWith('权限拒绝:')
      const sanitizedResult = result ? sanitizeToolOutput(toolCall.name, result, isErr) : result
      return {
        id: toolCall.id,
        name: toolCall.name,
        arguments: sanitizedArgs,
        status: getToolCallStatus(result),
        result: sanitizedResult
      }
    })

    if (message.blocks && message.blocks.length > 0) {
      // T01+T02：对已有 blocks 中的 tool block arguments 和 result 做摘要化/截断
      const sanitizedBlocks = message.blocks.map(block => {
        if (block.type === 'tool') {
          const blockResult = (block as import('../../shared/session/types').ToolBlock).result
          const isBlkErr = blockResult?.startsWith('工具执行失败') || blockResult?.startsWith('权限拒绝:')
          return {
            ...block,
            arguments: sanitizeToolInput(block.toolName, block.arguments),
            result: blockResult ? sanitizeToolOutput(block.toolName, blockResult, isBlkErr) : blockResult
          }
        }
        return block
      })
      return { ...message, content: sanitizedContent, toolCalls, blocks: sanitizedBlocks, _revision: 0 }
    }

    // 旧消息无 blocks：从 content 和 toolCalls 构造
    const blocks: MessageBlock[] = []
    if (sanitizedContent) {
      blocks.push({ type: 'text', content: sanitizedContent })
    }
    if (toolCalls) {
      for (const tc of toolCalls) {
        blocks.push({
          type: 'tool',
          toolCallId: tc.id,
          toolName: tc.name,
          arguments: tc.arguments,
          status: tc.status,
          result: tc.result
        })
      }
    }

    return { ...message, content: sanitizedContent, toolCalls, blocks, _revision: 0 }
  })
}

/** 把 SessionDetail 转成 Session 摘要并 upsert 到 sessions 列表头部 */
function upsertSessionSummary(sessions: Session[], detail: SessionDetail): Session[] {
  const nextSummary: Session = {
    id: detail.id,
    workspaceRoot: detail.workspaceRoot,
    mode: detail.mode,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
    messageCount: detail.messageCount
  }

  const others = sessions.filter(session => session.id !== detail.id)
  return [nextSummary, ...others]
}

/** 把单条 diff 文件标记为某个 review 状态（若该文件尚未进入 diffs 列表则先追加占位） */
function applyDiffReviewStatus(
  cache: MessageDiffCache,
  filePath: string,
  status: DiffReviewStatus
): MessageDiffCache {
  const existingDiff = cache.diffs.find(diff => diff.filePath === filePath)
  const nextDiffs = existingDiff
    ? cache.diffs
    : [...cache.diffs, { filePath, hunks: [], status: 'modified' as const }]

  return {
    diffs: nextDiffs,
    reviews: { ...cache.reviews, [filePath]: status }
  }
}

/** 给消息 bump 一次 _revision，返回新引用。所有 store 内 mutate 路径都通过它，保证 revision 单调递增。 */
function bumpRevision(msg: ExtendedMessage): ExtendedMessage {
  return { ...msg, _revision: (msg._revision ?? 0) + 1 }
}

/** 按 messageId 移除恢复 / Hook 相关临时状态（message-end 与 error 路径共用） */
function omitRecoveryFieldsForMessage(
  state: Pick<ChatState, 'recoveryState' | 'recoveryHints' | 'hookErrors'>,
  messageId: string
): Pick<ChatState, 'recoveryState' | 'recoveryHints' | 'hookErrors'> {
  const { [messageId]: _rs, ...restRecoveryState } = state.recoveryState
  const { [messageId]: _rh, ...restRecoveryHints } = state.recoveryHints
  const { [messageId]: _he, ...restHookErrors } = state.hookErrors
  return {
    recoveryState: restRecoveryState,
    recoveryHints: restRecoveryHints,
    hookErrors: restHookErrors
  }
}

/** 根据 messages 数组构建 id → index 索引，加速 delta handler O(1) 定位 */
function buildMessageIndex(messages: ExtendedMessage[]): Record<string, number> {
  const index: Record<string, number> = {}
  for (let i = 0; i < messages.length; i++) {
    index[messages[i].id] = i
  }
  return index
}

// ── Store 接口与实现 ──────────────────────────────────────

export interface ChatState {
  // ── 状态 ──
  sessions: Session[]
  currentSessionId: string | null
  messages: ExtendedMessage[]
  /** id → 数组索引，用于 delta handler O(1) 定位 */
  messageIndexById: Record<string, number>
  /**
   * 上次 syncFromWorkspace 见到的 messagesRevision。
   * 用于检测「同会话内消息序列变化」（回退/切分支），据此绕过 sessionChanged 守卫重拉消息。
   */
  lastMessagesRevision: number
  /**
   * 编辑/重新生成分叉后，待本轮流式结束再 bump messagesRevision，
   * 以便 load-session 下发 branch 元信息（翻页器可见）。
   */
  pendingBranchMetaReload: boolean
  /** prepare 与 send-message 之间的短窗口：禁止 switchBranch */
  branchForkInProgress: boolean
  /** Tier 1 切分支后的提示与 diff 灰显上下文（来自 WorkspaceState） */
  tier1BranchContext: Tier1BranchContext | null
  /** 与消息生成生命周期强绑定，写入由 sendMessage / handleMessageStart / handleError 触发 */
  isGenerating: boolean
  currentGeneratingMessageId: string | null

  /**
   * 流式工具调用参数累积：toolCallId → 已累积的 arguments 字符串。
   * start 时初始化为空字符串，delta 追加片段，最终 tool_call 事件到达后清空。
   */
  streamingToolArgs: Record<string, string>

  /** 每条消息的 diff 数据缓存 */
  messageDiffs: Record<string, MessageDiffCache>
  /** 正在加载 diff 的消息 ID 集合 */
  loadingDiffs: Set<string>
  /**
   * live 阶段的占位文件列表，仅在等待最终 diff 数据时使用。
   * 让 DiffViewer 在 skeleton 状态下也能展示文件名。
   */
  loadingDiffPlaceholders: Record<string, Array<{ filePath: string; status: DiffEntry['status'] }>>

  /**
   * Phase 6：Steering Queue 等待派发的用户消息。
   * Agent 运行期间用户仍可输入，输入的消息会进入此队列，
   * 在 turn boundary（handleMessageEnd / cancel 完成）自动 dispatch。
   */
  pendingUserMessages: Array<{ text: string; images: ImageAttachment[] }>

  /** 每条消息当前的恢复状态（retrying / recovering 等） */
  recoveryState: Record<string, RendererRecoveryState>
  /** 每条消息累积的恢复提示（按到达顺序追加） */
  recoveryHints: Record<string, Array<{ hint: string; attempt: number }>>
  /** 每条消息累积的 Hook 执行异常 */
  hookErrors: Record<string, Array<{ hookEvent: HookEvent; error: string }>>
  /** 每条消息回滚失败的错误提示（key 为 messageId） */
  rollbackErrors: Record<string, string>

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

  // ── Actions ──

  /** 加载会话列表 */
  loadSessions: () => Promise<void>
  /** 选中指定会话并加载消息 */
  selectSession: (sessionId: string) => Promise<void>
  /** 删除会话（当前会话被删时切到下一条或清空） */
  deleteSession: (sessionId: string) => Promise<void>
  /** 重命名会话标题 */
  renameSession: (sessionId: string, title: string) => Promise<void>
  /** 创建新会话 */
  createNewSession: (workspaceRoot?: string) => Promise<void>
  /** 发送用户消息（含图片） */
  sendMessage: (content: string, images?: ImageAttachment[]) => Promise<void>
  /** 按消息回退到某条消息之前的状态 */
  regenerateAssistant: (sessionId: string, messageId: string) => Promise<void>
  /** 切换到兄弟分支（翻页器） */
  switchBranch: (sessionId: string, targetMessageId: string) => Promise<void>
  /** 编辑某条用户消息并重发：分叉手术 + 乐观截断 + 复用流式发送 */
  editResend: (sessionId: string, messageId: string, newContent: string) => Promise<void>
  /** 按文件接受改动 */
  acceptFile: (sessionId: string, messageId: string, filePath: string) => Promise<void>
  /** 按文件拒绝改动 */
  rejectFile: (sessionId: string, messageId: string, filePath: string) => Promise<void>
  /** 批量接受多个文件改动（PRD §5.3） */
  acceptAllFiles: (sessionId: string, messageId: string, filePaths: string[]) => Promise<void>
  /** 批量拒绝多个文件改动（PRD §5.3），返回恢复成功与失败的文件 */
  rejectAllFiles: (sessionId: string, messageId: string, filePaths: string[]) => Promise<{ restored: string[]; failed: Array<{ filePath: string; error: string }> }>
  /** 加载某条消息的 diff 数据 */
  loadMessageDiffs: (sessionId: string, messageId: string) => Promise<void>
  /** 清除指定消息的 diff 缓存（拒绝后刷新用） */
  clearMessageDiffs: (messageId: string) => void
  /** 上滚到顶时加载更早一页消息并 prepend 到视窗 */
  loadOlderMessages: () => Promise<void>
  /**
   * 分叉轮次结束后 bump revision，拉取 branch 元信息；或 send 失败时强制与主进程对齐。
   */
  finishBranchMetaRefresh: () => Promise<void>
  /** 用户关闭 Tier 1 横幅 */
  dismissTier1BranchNotice: () => void

  /**
   * Phase 2 批量应用流式 delta：
   * 把同帧累积的 delta 按 messageId 分组合并，一次 set() 写回 store。
   * 接受三种 delta 类型：thinking / text / toolCall。
   */
  applyStreamDeltas: (deltas: StreamDeltaBatch) => void

  // ── 主进程事件 handler ──
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
   * @deprecated 仍是主进程 tool_call 终态事件（不含 streaming）的合法处理入口；
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
  /**
   * 主进程消息结束事件。
   * @param messageId 消息 ID
   * @param interrupted 是否为 cancel 中断结束（Phase 3）
   *
   * Phase 6：声明为 async 以便 await turn boundary 的 dispatchNextPending，
   * 调用方拿到 Promise resolve 时 store 状态已稳定（pending 已 dispatch）。
   */
  handleMessageEnd: (messageId: string, interrupted?: boolean) => Promise<void>
  handleError: (messageId: string, error: string) => Promise<void>
  handleVerificationResult: (messageId: string, result: string) => void
  /** 主进程 recovery_state 事件：更新当前消息的恢复状态机 */
  handleRecoveryState: (messageId: string, state: RendererRecoveryState) => void
  /** 主进程 recovery_hint 事件：追加一条恢复提示 */
  handleRecoveryHint: (messageId: string, hint: string, attempt: number) => void
  /** 主进程 hook_error 事件：记录 Hook 执行异常（不中断 Agent） */
  handleHookError: (messageId: string, hookEvent: HookEvent, error: string) => void

  /**
   * Phase 3：把当前所有 running tool 块标记为 error（"用户取消执行"）。
   * 由 useAgentStore.cancelExecution 触发，保留旧 useAppStore 的兜底行为。
   */
  markRunningAsCancelled: () => void

  /**
   * Phase 6：Steering Queue — 用户在 Agent 运行期间入队消息
   * 实际 dispatch 在 turn boundary 触发（handleMessageEnd / markRunningAsCancelled 后）
   */
  enqueuePendingMessage: (text: string, images: ImageAttachment[]) => void
  /** 取消某条挂起消息的排队（按索引） */
  removePendingMessage: (index: number) => void
  /** 清空全部挂起消息 */
  clearPendingMessages: () => void

  /**
   * PRD §5.1：把 workspace store 广播的工作区状态同步到本 store。
   * 由 workspaceDispatcher 调用（workspace:changed 事件的唯一副作用入口）。
   * - 同步 sessions 列表
   * - 若 currentSessionId 变化（含从 null 切到某会话 / 从某会话切到 null），
   *   重新加载该会话的消息（或清空）。
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

// ── Phase 6：Steering Queue 容量上限 ─────────────────────────────

/** 单个会话最多保留的挂起消息数。超过后丢弃最早入队的项。 */
const MAX_PENDING_MESSAGES = 20

// ── T05：消息窗口 LRU 裁剪常量 ──────────────────────────────

/** 消息数组超过此阈值触发裁剪 */
const MESSAGE_WINDOW_MAX_SIZE = 240
/** 裁剪时保留尾部最近的消息数 */
const MESSAGE_WINDOW_TAIL_PRESERVE = 80

// ── Phase 2：流式 delta 批量结构 ──────────────────────────────

/** 单条 delta 的统一结构（thinking / text / toolCall 三选一） */
export type StreamDelta =
  | { kind: 'thinking'; messageId: string; delta: string }
  | { kind: 'text'; messageId: string; delta: string }
  | { kind: 'toolCall'; messageId: string; toolCallId: string; delta: string }

/** 一次 flush 的批量 delta 数组 */
export type StreamDeltaBatch = StreamDelta[]

/** T05：消息窗口 LRU 裁剪。超过 MESSAGE_WINDOW_MAX_SIZE 时从头部裁剪，保留尾部 N 条 */
function trimMessageWindow(
  messages: ExtendedMessage[],
  index: Record<string, number>
): { messages: ExtendedMessage[]; index: Record<string, number>; headTrimmed: boolean } {
  if (messages.length <= MESSAGE_WINDOW_MAX_SIZE) {
    return { messages, index, headTrimmed: false }
  }
  const tailPreserve = messages.length - MESSAGE_WINDOW_TAIL_PRESERVE
  const trimCount = Math.min(messages.length - MESSAGE_WINDOW_MAX_SIZE, Math.max(0, tailPreserve))
  if (trimCount <= 0) return { messages, index, headTrimmed: false }
  const trimmed = messages.slice(trimCount)
  const newIndex: Record<string, number> = {}
  for (let i = 0; i < trimmed.length; i++) {
    newIndex[trimmed[i].id] = i
  }
  return { messages: trimmed, index: newIndex, headTrimmed: true }
}

/**
 * 头部裁剪后同步分页游标：被裁消息仍在盘上，可通过 loadOlderMessages 补回。
 */
function paginationPatchAfterHeadTrim(
  trimResult: { messages: ExtendedMessage[]; headTrimmed: boolean }
): Pick<ChatState, 'oldestLoadedMessageId' | 'hasMoreMessagesAbove'> | Record<string, never> {
  if (!trimResult.headTrimmed) return {}
  return {
    oldestLoadedMessageId: trimResult.messages[0]?.id ?? null,
    hasMoreMessagesAbove: true
  }
}

/**
 * 在 suspendHeadTrim 时跳过头部裁剪（P1-c：用户上滚补载后保留已 prepend 的早期历史）。
 */
function applyMessageWindowTrim(
  messages: ExtendedMessage[],
  index: Record<string, number>,
  suspendHeadTrim: boolean
): { messages: ExtendedMessage[]; index: Record<string, number>; headTrimmed: boolean } {
  if (suspendHeadTrim) return { messages, index, headTrimmed: false }
  return trimMessageWindow(messages, index)
}

/**
 * Phase 6：turn boundary 自动 dispatch 挂起消息。
 * 当 handleMessageEnd / markRunningAsCancelled 触发时，dequeue 第一条挂起消息并 sendMessage。
 *
 * 注意：get() 必须在 set() 之外调用，保证读到的 pendingUserMessages 是 set 之后的新值。
 * 同时 sendMessage 自身会 set isGenerating=true 并发起 IPC，与 dispatch 行为一致。
 *
 * 异步等待：sendMessage 是 async（含动态 import 与 IPC await），调用方应 await 本函数
 * 以确保 store 状态在 dispatch 后完全稳定（避免测试中读到中间态）。
 */
async function dispatchNextPending(get: () => ChatState): Promise<void> {
  const { pendingUserMessages, sendMessage, isGenerating } = get()
  if (isGenerating) return
  if (pendingUserMessages.length === 0) return
  const [next, ...rest] = pendingUserMessages
  // 同步移除队首，避免被多次 dispatch
  useChatStore.setState({ pendingUserMessages: rest })
  await sendMessage(next.text, next.images)
}

// ── Store 实现 ─────────────────────────────────────────────

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  currentSessionId: null,
  messages: [],
  messageIndexById: {},
  lastMessagesRevision: 0,
  pendingBranchMetaReload: false,
  branchForkInProgress: false,
  tier1BranchContext: null,
  isGenerating: false,
  currentGeneratingMessageId: null,
  streamingToolArgs: {},
  messageDiffs: {},
  loadingDiffs: new Set(),
  loadingDiffPlaceholders: {},
  pendingUserMessages: [],
  recoveryState: {},
  recoveryHints: {},
  hookErrors: {},
  rollbackErrors: {},
  hasMoreMessagesAbove: false,
  isLoadingOlderMessages: false,
  oldestLoadedMessageId: null,
  suspendHeadTrim: false,

  loadSessions: async () => {
    try {
      const sessions: Session[] = await window.api.invoke('load-sessions')
      set({ sessions })
    } catch (err) {
      console.error('加载会话列表出错:', err)
    }
  },

  deleteSession: async (sessionId: string) => {
    // PRD §5.1：删除会话统一走 workspace store。当前会话被删时由主进程自动切到下一条，
    // 广播 workspace:changed 后本 store 通过 dispatchWorkspaceChange 同步 messages / sessions。
    try {
      const { useWorkspaceStore } = await import('./useWorkspaceStore')
      await useWorkspaceStore.getState().deleteSession(sessionId)
    } catch (err) {
      console.error('删除会话出错:', err)
    }
  },

  renameSession: async (sessionId: string, title: string) => {
    const { useWorkspaceStore } = await import('./useWorkspaceStore')
    await useWorkspaceStore.getState().renameSession(sessionId, title)
  },

  sendMessage: async (content: string, images?: ImageAttachment[]) => {
    const { currentSessionId, isGenerating } = get()
    if (isGenerating) return

    // 新发消息会改变工作区语义，退出 Tier 1「仅对话历史」视图
    set({ tier1BranchContext: null })

    // PRD §5.1：project 路径统一从 workspace store 读取（单一事实源）
    const { useWorkspaceStore } = await import('./useWorkspaceStore')
    const currentProject = useWorkspaceStore.getState().currentProjectPath
    if (!currentProject) return

    const activeSessionId = currentSessionId || 'session_default'

    // 构建用户消息 blocks（含图片 ImageBlock）
    const blocks: MessageBlock[] = []
    if (content.trim()) {
      blocks.push({ type: 'text', content })
    }
    if (images && images.length > 0) {
      for (const img of images) {
        blocks.push({
          type: 'image',
          fileName: img.fileName,
          dataUrl: img.dataUrl,
          mimeType: img.mimeType
        })
      }
    }

    // 1. 创建并追加用户消息
    const userMsg: ExtendedMessage = {
      id: 'msg_' + Date.now() + '_user',
      sessionId: activeSessionId,
      role: 'user',
      content,
      blocks: blocks.length > 0 ? blocks : undefined,
      timestamp: Date.now(),
      _revision: 0
    }

    set(state => {
      const nextMessages = [...state.messages, userMsg]
      const trimmed = applyMessageWindowTrim(
        nextMessages,
        { ...state.messageIndexById, [userMsg.id]: nextMessages.length - 1 },
        state.suspendHeadTrim
      )
      return {
        messages: trimmed.messages,
        messageIndexById: trimmed.index,
        ...paginationPatchAfterHeadTrim(trimmed),
        isGenerating: true
      }
    })

    try {
      // 2. 异步发起 IPC 消息发送给主进程，主进程开始 Agent 循环并通过事件反馈
      await window.api.invoke('send-message', {
        sessionId: activeSessionId,
        content,
        userMessageId: userMsg.id,
        images: images?.map(img => ({
          fileName: img.fileName,
          data: img.dataUrl,
          mimeType: img.mimeType
        }))
      })
    } catch (err) {
      await get().handleError('msg_err_' + Date.now(), (err as Error).message)
    }
  },

  finishBranchMetaRefresh: async () => {
    if (!get().pendingBranchMetaReload) return
    set({ pendingBranchMetaReload: false })
    try {
      const { useWorkspaceStore } = await import('./useWorkspaceStore')
      await useWorkspaceStore.getState().bumpMessagesRevision()
    } catch (err) {
      console.error('[useChatStore] finishBranchMetaRefresh 失败:', err)
    }
  },

  dismissTier1BranchNotice: () => {
    set({ tier1BranchContext: null })
  },

  selectSession: async (sessionId: string) => {
    // PRD §5.1：会话切换统一走 workspace store（单一事实源），由主进程广播 workspace:changed
    // 触发 useChatStore 重新加载消息（见 dispatchWorkspaceChange 副作用）。
    // 本方法保留签名以兼容 useAppStore，内部只转发。
    const { useWorkspaceStore } = await import('./useWorkspaceStore')
    await useWorkspaceStore.getState().selectSession(sessionId)
  },

  regenerateAssistant: async (sessionId: string, messageId: string) => {
    if (get().isGenerating) return

    const { messages } = get()
    const assistantIdx = messages.findIndex(m => m.id === messageId)
    const parentUser = assistantIdx > 0 ? messages[assistantIdx - 1] : undefined
    if (parentUser?.role === 'user' && parentUser.blocks?.some(b => b.type === 'image')) {
      set(state => ({
        rollbackErrors: {
          ...state.rollbackErrors,
          [messageId]: '重新生成暂不支持含图片的消息'
        }
      }))
      return
    }

    set({ branchForkInProgress: true })

    try {
      const { useWorkspaceStore } = await import('./useWorkspaceStore')
      await useWorkspaceStore.getState().prepareRegenerate(sessionId, messageId)
      set(state => {
        const { [messageId]: _, ...rest } = state.rollbackErrors
        return { rollbackErrors: rest }
      })
    } catch (err) {
      set({ branchForkInProgress: false })
      const error = err instanceof Error ? err.message : '重新生成失败'
      console.error('重新生成出错:', err)
      set(state => ({
        rollbackErrors: { ...state.rollbackErrors, [messageId]: error }
      }))
      return
    }

    if (assistantIdx !== -1) {
      const truncated = messages.slice(0, assistantIdx)
      set({
        messages: truncated,
        messageIndexById: buildMessageIndex(truncated),
        messageDiffs: {},
        loadingDiffPlaceholders: {},
        loadingDiffs: new Set()
      })
    }

    set({ pendingBranchMetaReload: true })

    try {
      await window.api.invoke('send-message', {
        sessionId,
        content: '',
        regenerate: true
      })
    } catch (err) {
      await get().handleError('msg_err_' + Date.now(), (err as Error).message)
    }
  },

  switchBranch: async (sessionId: string, targetMessageId: string) => {
    if (get().isGenerating || get().branchForkInProgress) return

    try {
      const { useWorkspaceStore } = await import('./useWorkspaceStore')
      await useWorkspaceStore.getState().switchBranch(sessionId, targetMessageId)
      set(state => {
        const { [targetMessageId]: _, ...rest } = state.rollbackErrors
        return { rollbackErrors: rest }
      })
    } catch (err) {
      const error = err instanceof Error ? err.message : '切换分支失败'
      console.error('切换分支出错:', err)
      set(state => ({
        rollbackErrors: { ...state.rollbackErrors, [targetMessageId]: error }
      }))
    }
  },

  editResend: async (sessionId: string, messageId: string, newContent: string) => {
    if (get().isGenerating) return

    // 分叉准备 + 发送全程禁止翻页/切分支（prepare 与 send-message 是两段 IPC，中间须锁住）
    set({ branchForkInProgress: true })

    try {
      const { useWorkspaceStore } = await import('./useWorkspaceStore')
      await useWorkspaceStore.getState().prepareEditResend(sessionId, messageId)
      set(state => {
        const { [messageId]: _drop, ...rest } = state.rollbackErrors
        return { rollbackErrors: rest }
      })
    } catch (err) {
      set({ branchForkInProgress: false })
      const error = err instanceof Error ? err.message : '编辑重发失败'
      console.error('编辑重发出错:', err)
      set(state => ({
        rollbackErrors: { ...state.rollbackErrors, [messageId]: error }
      }))
      return
    }

    // 2. 乐观截断视图到分叉点（移除被编辑消息及其之后）。
    //    主进程 prepareEditResend 不 bump messagesRevision，不会触发 reload 覆盖这里。
    const { messages } = get()
    const idx = messages.findIndex(m => m.id === messageId)
    if (idx !== -1) {
      const truncated = messages.slice(0, idx)
      set({
        messages: truncated,
        messageIndexById: buildMessageIndex(truncated),
        // 分叉后旧 diff 缓存与磁盘可能不一致，清空避免误导
        messageDiffs: {},
        loadingDiffPlaceholders: {},
        loadingDiffs: new Set()
      })
    }

    // 3. 复用普通发送：乐观追加新用户消息 + 流式渲染。
    //    appendMessage 在主进程会把新用户消息的 parentId 设为分叉点，天然成兄弟分支。
    set({ pendingBranchMetaReload: true })
    await get().sendMessage(newContent)
  },

  /**
   * 创建新会话（用当前项目工作区，或显式传入 workspaceRoot）
   * PRD §5.1：统一转发到 workspace store，由主进程创建并广播。
   */
  createNewSession: async (workspaceRoot?: string) => {
    const { useWorkspaceStore } = await import('./useWorkspaceStore')
    const ws = useWorkspaceStore.getState()
    const targetProject = workspaceRoot || ws.currentProjectPath
    if (!targetProject) return
    try {
      await ws.createSession(targetProject, ws.currentMode)
    } catch (err) {
      console.error('创建新会话失败:', err)
    }
  },

  rejectFile: async (sessionId: string, messageId: string, filePath: string) => {
    try {
      await window.api.invoke('reject-file', { sessionId, messageId, filePath })
      const cache = get().messageDiffs[messageId]
      if (cache) {
        set(state => ({
          messageDiffs: {
            ...state.messageDiffs,
            [messageId]: applyDiffReviewStatus(cache, filePath, 'rejected')
          }
        }))
      }
    } catch (err) {
      console.error('拒绝文件改动出错:', err)
      throw err
    }
  },

  loadMessageDiffs: async (sessionId: string, messageId: string) => {
    const state = get()
    if (state.messageDiffs[messageId]) return

    set(s => ({
      loadingDiffs: new Set([...s.loadingDiffs, messageId])
    }))

    try {
      const result = await window.api.invoke('get-message-diffs', { sessionId, messageId })
      set(s => {
        const nextLoading = new Set(s.loadingDiffs)
        nextLoading.delete(messageId)
        const { [messageId]: _drop, ...nextPlaceholders } = s.loadingDiffPlaceholders
        return {
          messageDiffs: { ...s.messageDiffs, [messageId]: { diffs: result.diffs, reviews: result.reviews, skippedFiles: result.skippedFiles } },
          loadingDiffs: nextLoading,
          loadingDiffPlaceholders: nextPlaceholders
        }
      })
    } catch (err) {
      console.error('加载 diff 出错:', err)
      set(s => {
        const nextLoading = new Set(s.loadingDiffs)
        nextLoading.delete(messageId)
        return { loadingDiffs: nextLoading }
      })
    }
  },

  acceptFile: async (sessionId: string, messageId: string, filePath: string) => {
    try {
      await window.api.invoke('accept-file', { sessionId, messageId, filePath })
      const cache = get().messageDiffs[messageId]
      if (cache) {
        set(state => ({
          messageDiffs: {
            ...state.messageDiffs,
            [messageId]: applyDiffReviewStatus(cache, filePath, 'accepted')
          }
        }))
      }
    } catch (err) {
      console.error('接受文件出错:', err)
      throw err
    }
  },

  acceptAllFiles: async (sessionId: string, messageId: string, filePaths: string[]) => {
    if (filePaths.length === 0) return
    try {
      await window.api.invoke('accept-all-files', { sessionId, messageId, filePaths })
      const cache = get().messageDiffs[messageId]
      if (cache) {
        // 逐个 apply 后整体写入，避免多次 setState
        let updated = cache
        for (const fp of filePaths) {
          updated = applyDiffReviewStatus(updated, fp, 'accepted')
        }
        set(state => ({
          messageDiffs: { ...state.messageDiffs, [messageId]: updated }
        }))
      }
    } catch (err) {
      console.error('批量接受文件出错:', err)
      throw err
    }
  },

  rejectAllFiles: async (sessionId: string, messageId: string, filePaths: string[]) => {
    if (filePaths.length === 0) return { restored: [], failed: [] }
    try {
      const result = await window.api.invoke('reject-all-files', { sessionId, messageId, filePaths })
      const cache = get().messageDiffs[messageId]
      if (cache) {
        // 仅把恢复成功的文件标记为 rejected；失败的不改状态（UI 可单独提示）
        let updated = cache
        for (const fp of result.restored) {
          updated = applyDiffReviewStatus(updated, fp, 'rejected')
        }
        set(state => ({
          messageDiffs: { ...state.messageDiffs, [messageId]: updated }
        }))
      }
      if (result.failed.length > 0) {
        console.warn('部分文件拒绝失败:', result.failed)
      }
      return result
    } catch (err) {
      console.error('批量拒绝文件出错:', err)
      throw err
    }
  },

  clearMessageDiffs: (messageId: string) => {
    set(state => {
      const { [messageId]: _drop, ...rest } = state.messageDiffs
      return { messageDiffs: rest }
    })
  },

  loadOlderMessages: async () => {
    const {
      currentSessionId,
      oldestLoadedMessageId,
      hasMoreMessagesAbove,
      isLoadingOlderMessages
    } = get()

    if (!currentSessionId || !hasMoreMessagesAbove || isLoadingOlderMessages || !oldestLoadedMessageId) {
      return
    }

    const sessionIdAtStart = currentSessionId
    set({ isLoadingOlderMessages: true })

    try {
      const result = await window.api.invoke('load-session-messages', {
        sessionId: sessionIdAtStart,
        beforeId: oldestLoadedMessageId,
        limit: SESSION_HISTORY_PAGE_SIZE
      })

      if (get().currentSessionId !== sessionIdAtStart) {
        set({ isLoadingOlderMessages: false })
        return
      }

      const older = restoreSessionMessages(result.messages)
      if (older.length === 0) {
        set({ hasMoreMessagesAbove: result.hasMore, isLoadingOlderMessages: false })
        return
      }

      set(state => {
        const merged = [...older, ...state.messages]
        return {
          messages: merged,
          messageIndexById: buildMessageIndex(merged),
          hasMoreMessagesAbove: result.hasMore,
          oldestLoadedMessageId: merged[0]?.id ?? null,
          isLoadingOlderMessages: false,
          suspendHeadTrim: true
        }
      })
    } catch (err) {
      console.error('[useChatStore] loadOlderMessages 失败:', err)
      if (get().currentSessionId === sessionIdAtStart) {
        set({ isLoadingOlderMessages: false })
      }
    }
  },

  // ── 主进程流式事件响应器 ────────────────────────────────────

  handleMessageStart: (messageId: string) => {
    const { currentSessionId } = get()
    const activeSessionId = currentSessionId || 'session_default'

    // 收到 Assistant 消息开始，向消息队列追加一个空的 assistant 卡片
    const now = Date.now()
    const assistantMsg: ExtendedMessage = {
      id: messageId,
      sessionId: activeSessionId,
      role: 'assistant',
      content: '',
      toolCalls: [],
      timestamp: now,
      thinking: '',
      blocks: [],
      _revision: 0,
      turnStartedAt: now
    }

    set(state => {
      const nextMessages = [...state.messages, assistantMsg]
      return {
        messages: nextMessages,
        messageIndexById: { ...state.messageIndexById, [messageId]: nextMessages.length - 1 },
        currentGeneratingMessageId: messageId
      }
    })
  },

  /** @deprecated 见 ChatState 接口同名字段注释。 */
  handleThinkingDelta: (messageId: string, delta: string) => {
    set(state => {
      const idx = state.messageIndexById[messageId]
      if (idx === undefined) return state
      const msg = state.messages[idx]
      if (!msg) return state
      const blocks = msg.blocks ? [...msg.blocks] : []
      const last = blocks[blocks.length - 1]
      if (last && last.type === 'thinking') {
        blocks[blocks.length - 1] = { ...last, content: last.content + delta }
      } else {
        blocks.push({ type: 'thinking', content: delta })
      }
      const nextMessages = state.messages.slice()
      nextMessages[idx] = bumpRevision({ ...msg, thinking: (msg.thinking ?? '') + delta, blocks })
      return { messages: nextMessages }
    })
  },

  /** @deprecated 见 ChatState 接口同名字段注释。 */
  handleTextDelta: (messageId: string, delta: string) => {
    set(state => {
      const idx = state.messageIndexById[messageId]
      if (idx === undefined) return state
      const msg = state.messages[idx]
      if (!msg) return state
      const blocks = msg.blocks ? [...msg.blocks] : []
      const last = blocks[blocks.length - 1]
      if (last && last.type === 'text') {
        blocks[blocks.length - 1] = { ...last, content: last.content + delta }
      } else {
        blocks.push({ type: 'text', content: delta })
      }
      const nextMessages = state.messages.slice()
      nextMessages[idx] = bumpRevision({ ...msg, content: msg.content + delta, blocks })
      return { messages: nextMessages }
    })
  },

  handleToolCall: (messageId: string, toolCallId: string, toolName: string, args: Record<string, unknown>) => {
    // T01：在 args 写入 store 前对 write/edit 的 content 做摘要化
    const sanitizedArgs = sanitizeToolInput(toolName, args)

    const newToolCall: ExtendedToolCall = {
      id: toolCallId,
      name: toolName,
      arguments: sanitizedArgs,
      status: 'running'
    }

    set(state => {
      const idx = state.messageIndexById[messageId]
      if (idx === undefined) return state
      const msg = state.messages[idx]
      if (!msg) return state

      const cleanedMessage = stripInlinePseudoToolCalls(msg.content, msg.blocks ? [...msg.blocks] : [])

      // 查找是否已有 start 创建的占位 block
      const blocks = cleanedMessage.blocks
      const existingBlockIdx = blocks.findIndex(
        b => b.type === 'tool' && b.toolCallId === toolCallId
      )

      if (existingBlockIdx !== -1) {
        const existing = blocks[existingBlockIdx]
        if (existing.type === 'tool') {
          const { argumentsRaw: _drop, ...restBlock } = existing as RendererToolBlock
          blocks[existingBlockIdx] = {
            ...restBlock,
            type: 'tool',
            toolCallId,
            toolName,
            arguments: sanitizedArgs,
            status: 'running'
          }
        }
      } else {
        blocks.push({
          type: 'tool',
          toolCallId,
          toolName,
          arguments: sanitizedArgs,
          status: 'running'
        })
      }

      // 同步更新 toolCalls 数组
      const toolCalls = msg.toolCalls ? [...msg.toolCalls] : []
      const tcIdx = toolCalls.findIndex(tc => tc.id === toolCallId)
      if (tcIdx !== -1) {
        const { argumentsRaw: _tcDrop, ...restTc } = toolCalls[tcIdx]
        toolCalls[tcIdx] = { ...restTc, name: toolName, arguments: sanitizedArgs }
      } else {
        toolCalls.push(newToolCall)
      }

      const nextMessages = state.messages.slice()
      nextMessages[idx] = bumpRevision({ ...msg, content: cleanedMessage.content, toolCalls, blocks })

      const { [toolCallId]: _drop2, ...restStreaming } = state.streamingToolArgs
      return { messages: nextMessages, streamingToolArgs: restStreaming }
    })
  },

  handleToolCallStart: (messageId: string, toolCallId: string, toolName: string) => {
    const placeholder: ExtendedToolCall = {
      id: toolCallId,
      name: toolName,
      arguments: {},
      status: 'running'
    }

    set(state => {
      const idx = state.messageIndexById[messageId]
      if (idx === undefined) return state
      const msg = state.messages[idx]
      if (!msg) return state

      const blocks: RendererMessageBlock[] = msg.blocks ? [...msg.blocks] : []
      blocks.push({
        type: 'tool',
        toolCallId,
        toolName,
        arguments: {},
        status: 'running',
        argumentsRaw: ''
      })

      const toolCalls = msg.toolCalls ? [...msg.toolCalls, placeholder] : [placeholder]
      const nextMessages = state.messages.slice()
      nextMessages[idx] = bumpRevision({ ...msg, toolCalls, blocks })

      return {
        messages: nextMessages,
        streamingToolArgs: { ...state.streamingToolArgs, [toolCallId]: '' }
      }
    })
  },

  /** @deprecated 见 ChatState 接口同名字段注释。 */
  handleToolCallDelta: (messageId: string, toolCallId: string, argumentsDelta: string) => {
    set(state => {
      const idx = state.messageIndexById[messageId]
      if (idx === undefined) return state
      const msg = state.messages[idx]
      if (!msg) return state

      const prevRaw = state.streamingToolArgs[toolCallId] ?? ''
      const nextRaw = prevRaw + argumentsDelta

      const existingBlock = msg.blocks?.find(
        b => b.type === 'tool' && b.toolCallId === toolCallId
      )
      const toolName = existingBlock?.type === 'tool' ? existingBlock.toolName : ''
      const partialArgs = parsePartialToolArgs(toolName, nextRaw)

      const blocks: RendererMessageBlock[] = msg.blocks ? [...msg.blocks] : []
      const blockIdx = blocks.findIndex(
        b => b.type === 'tool' && b.toolCallId === toolCallId
      )
      if (blockIdx !== -1 && blocks[blockIdx].type === 'tool') {
        blocks[blockIdx] = {
          ...blocks[blockIdx],
          arguments: partialArgs,
          argumentsRaw: nextRaw
        } as RendererToolBlock
      }

      const toolCalls = msg.toolCalls ? msg.toolCalls.map(tc =>
        tc.id === toolCallId
          ? { ...tc, arguments: partialArgs, argumentsRaw: nextRaw }
          : tc
      ) : msg.toolCalls

      const nextMessages = state.messages.slice()
      nextMessages[idx] = bumpRevision({ ...msg, blocks, toolCalls })

      return {
        messages: nextMessages,
        streamingToolArgs: { ...state.streamingToolArgs, [toolCallId]: nextRaw }
      }
    })
  },

  handleToolResult: (messageId: string, toolCallId: string, _toolName: string, result: string) => {
    const isError = result.startsWith('工具执行失败') || result.startsWith('权限拒绝:')
    // T02：在 tool_result 写 store 前对输出做截断，防止大输出撑爆 heap
    const sanitizedResult = sanitizeToolOutput(_toolName, result, isError)

    set(state => {
      const idx = state.messageIndexById[messageId]
      if (idx === undefined) return state
      const msg = state.messages[idx]
      if (!msg) return state

      const blocks = msg.blocks?.map(b => {
        if (b.type === 'tool' && b.toolCallId === toolCallId) {
          return { ...b, status: isError ? 'error' as const : 'success' as const, result: sanitizedResult }
        }
        return b
      })

      const toolCalls = msg.toolCalls?.map(tc => {
        if (tc.id === toolCallId) {
          return { ...tc, result: sanitizedResult, status: isError ? 'error' as const : 'success' as const }
        }
        return tc
      })

      const nextMessages = state.messages.slice()
      nextMessages[idx] = bumpRevision({ ...msg, blocks, toolCalls })
      return { messages: nextMessages }
    })
  },

  /**
   * 工具执行后实时点亮 diff 区域。
   *
   * phase === 'live'：占位信号。后端只发了文件名 + status，没有 hunks。
   *   此时不写 messageDiffs（否则 DiffViewer 会按空 hunks 渲染出 +0 -0 中间态），
   *   仅把 messageId 标记为正在加载。
   * phase === 'final'：完整数据。直接覆盖缓存并清除 loading 标记和 placeholders。
   */
  handleDiffUpdate: (messageId, phase, diffs, reviews) => {
    if (phase === 'live') {
      if (get().messageDiffs[messageId]) return
      const placeholders = diffs.map(d => ({ filePath: d.filePath, status: d.status }))
      set(state => ({
        loadingDiffs: new Set([...state.loadingDiffs, messageId]),
        loadingDiffPlaceholders: {
          ...state.loadingDiffPlaceholders,
          [messageId]: placeholders
        }
      }))
      return
    }

    const nextDiffs = diffs.map(diffMeta => ({
      filePath: diffMeta.filePath,
      status: diffMeta.status,
      hunks: diffMeta.hunks ?? []
    }))

    set(state => {
      const nextLoading = new Set(state.loadingDiffs)
      nextLoading.delete(messageId)
      const { [messageId]: _drop, ...nextPlaceholders } = state.loadingDiffPlaceholders
      return {
        messageDiffs: {
          ...state.messageDiffs,
          [messageId]: {
            diffs: nextDiffs,
            reviews
          }
        },
        loadingDiffs: nextLoading,
        loadingDiffPlaceholders: nextPlaceholders
      }
    })
  },

  handleMessageEnd: async (messageId: string, interrupted?: boolean) => {
    set(state => {
      const nextMessages = state.messages.slice()
      const idx = state.messageIndexById[messageId]
      if (idx !== undefined && nextMessages[idx]) {
        const msg = nextMessages[idx]
        if (interrupted) {
          // Phase 3：取消中断结束时，把该消息的 running tool 块标记为 error
          // 并清空 argumentsRaw、附上 "用户取消执行" 结果。同时标记消息 interrupted。
          const blocks = msg.blocks?.map(b => {
            if (b.type === 'tool' && b.status === 'running') {
              const { argumentsRaw: _drop, ...restBlock } = b as RendererToolBlock
              return { ...restBlock, type: 'tool' as const, status: 'error' as const, result: '用户取消执行' }
            }
            return b
          })
          const toolCalls = msg.toolCalls?.map(tc => {
            if (tc.status === 'running') {
              const { argumentsRaw: _tcDrop, ...restTc } = tc
              return { ...restTc, status: 'error' as const, result: '用户取消执行' }
            }
            return tc
          })
          nextMessages[idx] = bumpRevision({
            ...msg,
            interrupted: true,
            blocks,
            toolCalls,
            turnEndedAt: Date.now()
          })
        } else {
          nextMessages[idx] = bumpRevision({
            ...msg,
            turnEndedAt: Date.now()
          })
        }
      }
      return {
        messages: nextMessages,
        isGenerating: false,
        currentGeneratingMessageId: null,
        branchForkInProgress: false,
        ...omitRecoveryFieldsForMessage(state, messageId),
        // 中断时清空所有流式工具参数累积
        ...(interrupted ? { streamingToolArgs: {} } : {})
      }
    })

    // 更新当前会话的消息数属性，并自动加载 diff
    const { currentSessionId, sessions, messages } = get()
    if (currentSessionId) {
      get().loadMessageDiffs(currentSessionId, messageId)
      set({
        sessions: sessions.map(s =>
          s.id === currentSessionId ? { ...s, messageCount: messages.length, updatedAt: Date.now() } : s
        )
      })
    }

    // 正常完成路径：清除 agent store 的 5s 兜底定时器。
    // 即使是 interrupted 路径，message-end 已正常到达，定时器也不应再触发。
    const { useAgentStore } = await import('./useAgentStore')
    useAgentStore.getState().clearCancelFallback()

    // Phase 6：turn boundary 自动 dispatch 挂起消息
    await dispatchNextPending(get)

    // 分叉轮次正常结束：补 bump revision 拉取 branch 元信息（翻页器）
    await get().finishBranchMetaRefresh()
  },

  handleError: async (messageId: string, error: string) => {
    const { currentSessionId } = get()
    const activeSessionId = currentSessionId || 'session_default'

    set(state => {
      const idx = state.messageIndexById[messageId]
      const commonFields = {
        isGenerating: false,
        currentGeneratingMessageId: null,
        branchForkInProgress: false,
        // error 路径不发射 message-end，此处同步清理恢复状态，避免残留
        ...omitRecoveryFieldsForMessage(state, messageId)
      }

      if (idx !== undefined && state.messages[idx]) {
        // 消息已存在（handleMessageStart 已追加空气泡）：就地更新为错误卡片，
        // 避免同一 messageId 在列表中出现两条，导致 React key 冲突与界面闪烁
        const nextMessages = state.messages.slice()
        nextMessages[idx] = bumpRevision({
          ...state.messages[idx]!,
          content: error,
          isError: true,
          // 清空流式中间态，避免空气泡残留
          thinking: undefined,
          blocks: undefined,
          toolCalls: undefined
        })
        return { messages: nextMessages, ...commonFields }
      }

      // 罕见 fallback：error 在 message_start 之前到达，此时列表里还没有这条消息，
      // 才走追加路径（保持 messageIndexById 一致性）
      const errorMsg: ExtendedMessage = {
        id: messageId,
        sessionId: activeSessionId,
        role: 'assistant',
        content: error,
        isError: true,
        timestamp: Date.now(),
        _revision: 0
      }
      const nextMessages = [...state.messages, errorMsg]
      return {
        messages: nextMessages,
        messageIndexById: { ...state.messageIndexById, [messageId]: nextMessages.length - 1 },
        ...commonFields
      }
    })

    if (get().pendingBranchMetaReload) {
      await get().finishBranchMetaRefresh()
    }
  },

  handleVerificationResult: (messageId: string, result: string) => {
    set(state => {
      const idx = state.messageIndexById[messageId]
      if (idx === undefined) return state
      const msg = state.messages[idx]
      if (!msg) return state
      const nextMessages = state.messages.slice()
      nextMessages[idx] = bumpRevision({ ...msg, verificationSummary: result })
      return { messages: nextMessages }
    })
  },

  handleRecoveryState: (messageId: string, recovery: RendererRecoveryState) => {
    set(state => ({
      recoveryState: { ...state.recoveryState, [messageId]: recovery }
    }))
  },

  handleRecoveryHint: (messageId: string, hint: string, attempt: number) => {
    set(state => ({
      recoveryHints: {
        ...state.recoveryHints,
        [messageId]: [...(state.recoveryHints[messageId] ?? []), { hint, attempt }]
      }
    }))
  },

  handleHookError: (messageId: string, hookEvent: HookEvent, error: string) => {
    set(state => ({
      hookErrors: {
        ...state.hookErrors,
        [messageId]: [...(state.hookErrors[messageId] ?? []), { hookEvent, error }]
      }
    }))
  },

  markRunningAsCancelled: async () => {
    set(state => {
      const nextMessages = state.messages.map(msg => {
        if (!msg.blocks && !msg.toolCalls) return msg
        let changed = false

        const blocks = msg.blocks?.map(b => {
          if (b.type === 'tool' && b.status === 'running') {
            changed = true
            const { argumentsRaw: _drop, ...restBlock } = b as RendererToolBlock
            return { ...restBlock, type: 'tool' as const, status: 'error' as const, result: '用户取消执行' }
          }
          return b
        })

        const toolCalls = msg.toolCalls?.map(tc => {
          if (tc.status === 'running') {
            changed = true
            const { argumentsRaw: _tcDrop, ...restTc } = tc
            return { ...restTc, status: 'error' as const, result: '用户取消执行' }
          }
          return tc
        })

        return changed ? bumpRevision({ ...msg, blocks, toolCalls }) : msg
      })

      return {
        messages: nextMessages,
        isGenerating: false,
        currentGeneratingMessageId: null,
        streamingToolArgs: {}
      }
    })

    // Phase 6：cancel 兜底路径也是 turn boundary，dispatch 挂起消息
    // 同时清除 agent store 的 5s 兜底定时器（虽然 markRunningAsCancelled 本身就是兜底终点，
    // 但保险起见显式清除一次，避免后续 cancel 流程出现多个并存定时器）。
    const { useAgentStore } = await import('./useAgentStore')
    useAgentStore.getState().clearCancelFallback()
    await dispatchNextPending(get)
  },

  enqueuePendingMessage: (text, images) => {
    set(state => {
      // 防止用户疯狂输入导致队列无限增长。超过上限时丢弃最早的项。
      if (state.pendingUserMessages.length >= MAX_PENDING_MESSAGES) {
        const dropped = state.pendingUserMessages.length - MAX_PENDING_MESSAGES + 1
        console.warn(`[enqueuePendingMessage] 队列已满（${MAX_PENDING_MESSAGES}），丢弃最早的 ${dropped} 条`)
        return {
          pendingUserMessages: [
            ...state.pendingUserMessages.slice(dropped),
            { text, images: [...images] }
          ]
        }
      }
      return {
        pendingUserMessages: [...state.pendingUserMessages, { text, images: [...images] }]
      }
    })
  },

  removePendingMessage: (index) => {
    set(state => ({
      pendingUserMessages: state.pendingUserMessages.filter((_, i) => i !== index)
    }))
  },

  clearPendingMessages: () => {
    set({ pendingUserMessages: [] })
  },

  /**
   * Phase 2：批量应用 delta。
   * 把同帧累积的 delta 按 messageId 分组、对同消息的同 kind 合并，
   * 一次 set() 写回 store，避免一帧多次 set() 触发多次 React 重渲染。
   *
   * 实现要点：先按 messageId 聚合 delta，再对每条消息只重建一次数组
   * （避免之前每条 delta 都 `const next = [...nextMessages]` 产生的 O(N²) 拷贝）。
   *
   * 行为与单次 handleXxxDelta 完全一致：按 messageId 找到消息，
   * 按 kind 找到或新建对应 block，再追加内容。
   */
  applyStreamDeltas: (deltas: StreamDeltaBatch) => {
    if (deltas.length === 0) return

    set(state => {
      // 第一步：按 messageId 聚合 delta，保留组内到达顺序
      const byMessageId = new Map<string, StreamDelta[]>()
      for (const delta of deltas) {
        if (state.messageIndexById[delta.messageId] === undefined) continue
        let arr = byMessageId.get(delta.messageId)
        if (!arr) {
          arr = []
          byMessageId.set(delta.messageId, arr)
        }
        arr.push(delta)
      }

      // 第二步：拷贝 messages 一次（顶层），对每条消息只在其 blocks 层级再拷贝
      const nextMessages = state.messages.slice()
      const nextStreaming: Record<string, string> = { ...state.streamingToolArgs }
      let messagesChanged = false
      let streamingChanged = false

      for (const [messageId, messageDeltas] of byMessageId) {
        const idx = state.messageIndexById[messageId]
        if (idx === undefined) continue
        const msg = nextMessages[idx]
        if (!msg) continue

        let workingBlocks: RendererMessageBlock[] | undefined = msg.blocks ? [...msg.blocks] : undefined
        let workingToolCalls = msg.toolCalls
        let workingContent = msg.content
        let workingThinking = msg.thinking ?? ''

        for (const delta of messageDeltas) {
          if (delta.kind === 'thinking') {
            const blocks = workingBlocks ?? []
            const last = blocks[blocks.length - 1]
            if (last && last.type === 'thinking') {
              // T07：原地 += 而非创建新对象，减少 GC 压力
              ;(last as { content: string }).content += delta.delta
            } else {
              blocks.push({ type: 'thinking', content: delta.delta })
            }
            workingBlocks = blocks
            workingThinking += delta.delta
          } else if (delta.kind === 'text') {
            const blocks = workingBlocks ?? []
            const last = blocks[blocks.length - 1]
            if (last && last.type === 'text') {
              // T07：原地 += 而非创建新对象
              ;(last as { content: string }).content += delta.delta
            } else {
              blocks.push({ type: 'text', content: delta.delta })
            }
            workingBlocks = blocks
            workingContent += delta.delta
          } else {
            // toolCall delta：累积 argumentsRaw + partial 解析 + 更新 block / toolCalls
            //
            // 防御（竞态双保险）：若该 tool block 已被 handleToolCall finalize
            // （finalize 时会删除 block.argumentsRaw 字段），说明完整 args 已写入，
            // 此时任何迟到的 buffered partial delta 都不能再覆盖完整 args，直接跳过。
            // 主修在 App.tsx：tool-call 最终事件前先 flushNow；这里是顺序兜底。
            const finalizedBlocks = workingBlocks ?? []
            const finalizedIdx = finalizedBlocks.findIndex(
              b => b.type === 'tool' && b.toolCallId === delta.toolCallId
            )
            if (finalizedIdx !== -1 && finalizedBlocks[finalizedIdx].type === 'tool') {
              const finalizedBlock = finalizedBlocks[finalizedIdx] as RendererToolBlock
              if (finalizedBlock.argumentsRaw === undefined) {
                continue
              }
            }

            const prevRaw = nextStreaming[delta.toolCallId] ?? ''
            const nextRaw = prevRaw + delta.delta
            nextStreaming[delta.toolCallId] = nextRaw
            streamingChanged = true

            // 一次性查 blocks 找到对应 tool block 并取出 toolName，
            // 避免在 toolCalls.map 里再 find 两次 + 重复 parsePartialToolArgs。
            const blocks = workingBlocks ?? []
            const blockIdx = blocks.findIndex(
              b => b.type === 'tool' && b.toolCallId === delta.toolCallId
            )
            const toolBlock = blockIdx !== -1 && blocks[blockIdx].type === 'tool'
              ? blocks[blockIdx]
              : null
            const partialArgs = toolBlock
              ? parsePartialToolArgs(toolBlock.toolName, nextRaw)
              : null

            // T01：流式累积的 partialArgs 也做摘要化，防止大文件流式期间撑大 heap
            const sanitizedPartialArgs = partialArgs !== null && toolBlock
              ? sanitizeToolInput(toolBlock.toolName, partialArgs)
              : partialArgs

            if (toolBlock && sanitizedPartialArgs !== null) {
              blocks[blockIdx] = {
                ...toolBlock,
                arguments: sanitizedPartialArgs,
                argumentsRaw: nextRaw
              } as RendererToolBlock
              workingBlocks = blocks
            }

            if (workingToolCalls && toolBlock && sanitizedPartialArgs !== null) {
              workingToolCalls = workingToolCalls.map(tc =>
                tc.id === delta.toolCallId
                  ? { ...tc, arguments: sanitizedPartialArgs, argumentsRaw: nextRaw }
                  : tc
              )
            } else if (workingToolCalls && !toolBlock) {
              // 块还没起来时（tool_call_start 还没到），仍要更新 toolCalls[].argumentsRaw，
              // 这样 toolCallStart 事件上来时不会丢失已经累积的 raw。
              workingToolCalls = workingToolCalls.map(tc =>
                tc.id === delta.toolCallId
                  ? { ...tc, argumentsRaw: nextRaw }
                  : tc
              )
            }
          }
        }

        // 整条消息处理完，原子写回 nextMessages[idx]
        nextMessages[idx] = bumpRevision({
          ...msg,
          content: workingContent,
          thinking: workingThinking,
          blocks: workingBlocks,
          toolCalls: workingToolCalls
        })
        messagesChanged = true
      }

      // T05：流式 delta 处理完后裁剪消息窗口
      let finalResult: Partial<ChatState>
      if (messagesChanged) {
        const trimmed = applyMessageWindowTrim(
          nextMessages,
          state.messageIndexById,
          state.suspendHeadTrim
        )
        finalResult = {
          messages: trimmed.messages,
          ...(trimmed.messages !== nextMessages ? { messageIndexById: trimmed.index } : {}),
          ...paginationPatchAfterHeadTrim(trimmed),
          ...(streamingChanged ? { streamingToolArgs: nextStreaming } : {})
        }
      } else {
        finalResult = {
          ...(streamingChanged ? { streamingToolArgs: nextStreaming } : {})
        }
      }

      return finalResult
    })
  },

  syncFromWorkspace: (next) => {
    const prev = get()
    const sessionChanged = prev.currentSessionId !== next.currentSessionId
    // 同会话内消息序列变化（回退/切分支）：currentSessionId 不变但 revision 递增。
    // 单纯靠 sessionChanged 会漏掉这类变更，导致「主进程切了、界面没切」。
    const revisionChanged = next.messagesRevision !== prev.lastMessagesRevision

    // 1. 同步 sessions 列表 + currentSessionId + revision + Tier 1 上下文
    set({
      sessions: next.availableSessions,
      currentSessionId: next.currentSessionId,
      lastMessagesRevision: next.messagesRevision,
      tier1BranchContext: sessionChanged ? null : next.tier1BranchContext
    })

    // 2. 会话切换 或 同会话内消息序列变化时，重新加载消息（或清空）
    if (sessionChanged || revisionChanged) {
      // 清空 diff 缓存与分页视窗，避免跨会话污染
      set({
        messageDiffs: {},
        loadingDiffPlaceholders: {},
        hasMoreMessagesAbove: false,
        isLoadingOlderMessages: false,
        oldestLoadedMessageId: null,
        suspendHeadTrim: false
      })

      if (next.currentSessionId) {
        // 异步加载该会话首屏尾部消息（主进程只返回最近 N 条 + hasMore 标记）
        void (async () => {
          try {
            const detail: SessionDetail = await window.api.invoke('load-session', { sessionId: next.currentSessionId! })
            // 二次校验：加载期间用户可能又切了会话，只有 still current 时才 set
            if (get().currentSessionId !== next.currentSessionId) return
            const restored = restoreSessionMessages(detail.messages)
            set({
              messages: restored,
              messageIndexById: buildMessageIndex(restored),
              hasMoreMessagesAbove: detail.hasMoreMessagesAbove ?? false,
              oldestLoadedMessageId: restored[0]?.id ?? null,
              isLoadingOlderMessages: false,
              suspendHeadTrim: false
            })
          } catch (err) {
            console.error('[useChatStore] syncFromWorkspace 加载会话消息失败:', err)
          }
        })()
      } else {
        // 切到"无会话"状态：清空消息
        set({ messages: [], messageIndexById: {} })
      }
    }
  }
}))

/**
 * 重置整个 chat store 到默认值。供测试 setup 复用。
 * 不导出给生产代码使用，保留为内部测试辅助。
 */
export function resetChatStoreForTests(): void {
  useChatStore.setState({
    sessions: [],
    currentSessionId: null,
    messages: [],
    messageIndexById: {},
    lastMessagesRevision: 0,
    pendingBranchMetaReload: false,
    branchForkInProgress: false,
    tier1BranchContext: null,
    isGenerating: false,
    currentGeneratingMessageId: null,
    streamingToolArgs: {},
    messageDiffs: {},
    loadingDiffs: new Set(),
    loadingDiffPlaceholders: {},
    pendingUserMessages: [],
    recoveryState: {},
    recoveryHints: {},
    hookErrors: {},
    rollbackErrors: {},
    hasMoreMessagesAbove: false,
    isLoadingOlderMessages: false,
    oldestLoadedMessageId: null,
    suspendHeadTrim: false
  })
}

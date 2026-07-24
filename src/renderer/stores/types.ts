/**
 * 渲染器专用的扩展类型
 *
 * 仅在 renderer 内部使用，不污染 shared 层。
 * 把 useAppStore 拆分为 useChatStore / useAgentStore / useSettingsStore 之后，
 * 这部分类型被三个 store 共同依赖，所以集中放在独立文件，避免循环引用。
 */
import type {
  Message,
  MessageBlock,
  TextBlock,
  ThinkingBlock,
  ToolBlock,
  ImageBlock,
  ToolCall,
  BranchMeta
} from '../../shared/session/types'
import type { DiffEntry, DiffReviewStatus, SkippedFileInfo } from '../../shared/diff/types'

/** 流式增量阶段携带的额外字段：原始 JSON 字符串 */
export type RendererToolBlock = ToolBlock & { argumentsRaw?: string }

/** 顺序消息块：ToolBlock 使用携带 argumentsRaw 的 renderer 扩展版本 */
export type RendererMessageBlock = ThinkingBlock | TextBlock | RendererToolBlock | ImageBlock

/** 渲染器专用 ToolCall：携带执行状态、结果、原始 JSON */
export interface ExtendedToolCall extends ToolCall {
  result?: string
  status: 'running' | 'success' | 'error'
  argumentsRaw?: string
}

/** 渲染器专用消息：在 shared Message 基础上携带流式渲染状态 */
export interface ExtendedMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  toolCalls?: ExtendedToolCall[]
  timestamp: number
  isError?: boolean
  thinking?: string
  blocks?: RendererMessageBlock[]
  /**
   * true 表示本条消息是 cancel 中断产生的（由主进程 message-end 事件携带的
   * interrupted 字段写入，前端在 Phase 3 用于 UI 区分"已中断"和"已完成"）。
   * 普通完成的消息不写此字段，UI 视为未设置即可。
   */
  interrupted?: boolean
  /** 存在兄弟分支时由主进程附加，供翻页器 ‹ k/n › */
  branch?: BranchMeta
  /**
   * 渲染优化用的内部修订号。每次 store 内对该消息的 mutation 都会 bump，
   * MessageItem 用 React.memo 比 _revision 即可精确判断"该消息变没变"，
   * 避免 ChatPanel 整盘 messages.map 触发的子组件 reconciliation。
   * 不持久化，不参与跨进程 IPC。
   */
  _revision?: number
  /** L1「Worked for」计时起点；handleMessageStart 写入。仅渲染层内存：持久化类型 SessionMessage 不含此字段，重载/切分支重放后丢失，L1 降级为无时长显示 */
  turnStartedAt?: number
  /** L1 计时终点；handleMessageEnd 写入。同上：仅渲染层内存存活一个轮次，重载后丢失 */
  turnEndedAt?: number
}

/** 等待用户决策的权限请求 */
export interface PendingPermissionRequest {
  messageId: string
  requestId: string
  toolName: string
  args: Record<string, unknown>
  riskLevel: 'low' | 'medium' | 'high'
  reason: string
  commands?: string[]
  /** 本次请求对应的工具卡片 id 列表，内联放行据此锚定到具体卡片（锚点取末尾一张） */
  toolCallIds?: string[]
  /** InteractionInbox 归属（阶段 2，可选兼容旧事件） */
  interactionId?: string
  runId?: string
  sessionId?: string
  version?: number
}

/** 单条消息的 diff 缓存 */
export interface MessageDiffCache {
  diffs: DiffEntry[]
  reviews: Record<string, DiffReviewStatus>
  /** 因过大等原因未生成 snapshot 的文件 */
  skippedFiles?: SkippedFileInfo[]
}

/** 工具调用持久化时携带的 tool_call 结果映射（仅后端 IPC 协议用） */
export type SessionMessagePayload = Message & { _toolCallResults?: Record<string, string> }

/** 会话级 token 用量聚合统计 */
export interface SessionUsageStats {
  totalUncachedInputTokens: number
  totalCacheReadTokens: number
  totalCacheWriteTokens: number
  totalOutputTokens: number
  /**
   * 兼容别名：= totalUncachedInputTokens + totalCacheReadTokens
   */
  totalPromptTokens: number
  /** 兼容别名：= totalOutputTokens */
  totalCompletionTokens: number
  /** 兼容别名：= totalCacheReadTokens */
  totalCachedTokens: number
  /**
   * 缓存未命中累计（仅当某轮 usage 确有 cacheMissTokens 时累计）。
   * optional：无 miss 报告的会话不出现该字段，UI 不得显示为 0。
   */
  totalCacheMissTokens?: number
  /**
   * 会话累计命中率：cacheRead / (uncached + cacheRead + cacheWrite)
   */
  hitRate: number
  /** 最近一轮命中率（同上公式，单轮四元组） */
  lastRoundHitRate: number
  /** 估算节省的输入 tokens（累计 cacheRead） */
  estimatedSavedInputTokens: number
}

import type {
  SubagentActivityProjection,
  SubagentSessionListMetadata
} from '../subagents'
import type { ComposePlanApproval, ComposeStageEntry } from '../composeLifecycle'
import type { TodoItem } from '../todo/types'

/** 运行模式：plan 只读分析、default 协作模式、auto 高自动化 */
/**
 * 行为模式（ModeSwitch）：
 * - default：模型自主循环（协作聊天）
 * - plan：只读规划
 * - compose：编排脚本强制推进（阶段 C1）
 * 权限档位已迁出为 PermissionPolicy（设置），不再用 Mode 表达 auto。
 */
export type Mode = 'plan' | 'default' | 'compose'

/** 工具批准策略（仅约束 default 模式；plan/compose 由模式硬约束） */
export type PermissionPolicy = 'ask' | 'auto'

/** 权限决策：允许 / 需确认 / 拒绝 */
export type PermissionDecision = 'allow' | 'ask' | 'deny'

/** 消息角色 */
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool'

/** 工具调用记录 */
export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

// ── 顺序消息块类型 ──────────────────────────────────

/** 思考块 */
export interface ThinkingBlock {
  type: 'thinking'
  content: string
  /**
   * 产生该 thinking 的缓存档案 ID（如 glm / kimi / deepseek）。
   * 用于跨模型回放门控；旧数据缺省时视为与当前档案兼容。
   */
  providerId?: string
  /**
   * 本段思考耗时（毫秒）。流式封存时写入并随消息持久化；旧数据缺省。
   */
  durationMs?: number
}

/** 正文块 */
export interface TextBlock {
  type: 'text'
  content: string
}

/** 工具调用块 */
export interface ToolBlock {
  type: 'tool'
  toolCallId: string
  toolName: string
  arguments: Record<string, unknown>
  status: 'running' | 'success' | 'error'
  result?: string
}

/** 图片块（用户消息中携带的图片，用于 UI 流式渲染） */
export interface ImageBlock {
  type: 'image'
  fileName: string
  /** base64 data: URI，可直接作为 <img src> 渲染 */
  dataUrl: string
  mimeType: string
}

/** 顺序消息块：按流式事件的到达顺序排列 */
export type MessageBlock = ThinkingBlock | TextBlock | ToolBlock | ImageBlock

// ── 消息类型 ──────────────────────────────────────────────

/** 分叉点 UI 元信息（主进程折叠 active path 时附加） */
export interface BranchMeta {
  /** 当前节点在兄弟中的序号（1-based） */
  index: number
  /** 兄弟分支总数 */
  total: number
  /** 所有兄弟节点 id（含自身），按 timestamp 升序 */
  siblingIds: string[]
}

/** 单条消息 */
export interface Message {
  id: string
  sessionId: string
  role: MessageRole
  /**
   * 正文文本。新版本以 blocks 为事实源时，content 为加载投影，勿与 blocks 双向同步写。
   */
  content: string
  /**
   * 工具调用列表。新版本由 blocks 中 tool 块投影而来。
   */
  toolCalls?: ToolCall[]
  /**
   * 顺序块数组，按流式事件顺序排列的 thinking/text/tool 块。
   * 新版本消息以此为唯一事实源。
   */
  blocks?: MessageBlock[]
  /** 单条消息 schema 子版本；1 = blocks 为事实源 */
  messageSchemaVersion?: number
  /**
   * true 表示本条消息是 cancel 中断产生的。
   * 持久化层在 saveAssistantMessage 时根据 message_end.interrupted 写入，
   * 历史会话加载后 UI 据此显示「已中断」标识。
   */
  interrupted?: boolean
  /** 存在兄弟分支时由主进程附加，供 UI 翻页器展示 ‹ k/n › */
  branch?: BranchMeta
  /** assistant 回合的开始时刻，用于历史工作时长展示 */
  turnStartedAt?: number
  /** assistant 回合的结束时刻，用于历史工作时长展示 */
  turnEndedAt?: number
  timestamp: number
}

interface SessionBase {
  id: string
  workspaceRoot: string
  mode: Mode
  createdAt: number
  updatedAt: number
  messageCount: number
  /** 侧边栏展示的会话标题 */
  title?: string
  /** 置顶标记：置顶会话在侧边栏独立分区展示；旧会话缺省视为未置顶 */
  pinned?: boolean
}

/** 普通会话摘要不携带 child lineage。 */
export interface PrimarySession extends SessionBase {
  kind: 'primary'
  subagent?: never
}

/** Child Session 摘要只暴露导航所需的窄 lineage/profile。 */
export interface SubagentSession extends SessionBase {
  kind: 'subagent'
  subagent: SubagentSessionListMetadata
}

/** 会话摘要（用于列表展示，不含消息体）。 */
export type Session = PrimarySession | SubagentSession

/** 会话详情（含完整消息列表，用于加载历史对话） */
export type SessionDetail = Session & {
  messages: Message[]
  /** 当前会话直接拥有的 Child Session 投影，可由 durable owners 重新构建。 */
  subagentProjections: SubagentActivityProjection[]
  /** Child Session 原始任务从首条 user message 派生，不复制进 metadata。 */
  subagentTask?: string
  /**
   * 首屏是否只返回了尾部子集；为 true 时表示 messages 之前还有更早历史，
   * 可通过 load-session-messages 按游标补载。
   */
  hasMoreMessagesAbove?: boolean
  /** 当前激活叶子 id；正常 UI 不依赖，调试与 Tier 1 上下文用 */
  currentLeafId?: string | null
  /**
   * compose 生命周期阶段表。仅 compose 会话由 stage_transition 工具写入；
   * 旧会话缺省，renderer 按初始表投影纯显示，不回填落盘。
   */
  composeStages?: ComposeStageEntry[]
  /**
   * 修复-复审循环计数（审查阶段回退放行次数，代码兜底上限 3）。
   * 随详情水合阶段条，用于预禁用已达上限的回退入口；旧会话缺省视为 0。
   */
  composeReviewLoops?: number
  /**
   * 计划阶段确认门状态。仅 compose 会话由 save_plan / stage_transition / 批准 IPC 写入；
   * 旧会话缺省，renderer 视为 pending。
   */
  composePlanApproval?: ComposePlanApproval
  /**
   * 会话级待办清单随详情透出，renderer 水合 TodoPanel 与 compose 阶段条进度；
   * 旧会话或从未写过待办的会话缺省。
   */
  todos?: TodoItem[]
}

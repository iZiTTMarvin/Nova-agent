/** 运行模式：plan 只读分析、default 协作模式、auto 高自动化 */
export type Mode = 'plan' | 'default' | 'auto'

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

// ── 顺序消息块类型 (S13) ──────────────────────────────────

/** 思考块 */
export interface ThinkingBlock {
  type: 'thinking'
  content: string
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

/** 单条消息 */
export interface Message {
  id: string
  sessionId: string
  role: MessageRole
  content: string
  toolCalls?: ToolCall[]
  /** 顺序块数组 (S13)，按流式事件顺序排列的 thinking/text/tool 块 */
  blocks?: MessageBlock[]
  /** 验证结果摘要 (S14)，修改后自动验证的结果 */
  verificationSummary?: string
  /**
   * Phase 3：true 表示本条消息是 cancel 中断产生的。
   * 持久化层在 saveAssistantMessage 时根据 message_end.interrupted 写入，
   * 历史会话加载后 UI 据此显示「已中断」标识。
   */
  interrupted?: boolean
  timestamp: number
}

/** 会话摘要（用于列表展示，不含消息体） */
export interface Session {
  id: string
  workspaceRoot: string
  mode: Mode
  createdAt: number
  updatedAt: number
  messageCount: number
}

/** 会话详情（含完整消息列表，用于加载历史对话） */
export interface SessionDetail extends Session {
  messages: Message[]
  /**
   * 首屏是否只返回了尾部子集；为 true 时表示 messages 之前还有更早历史，
   * 可通过 load-session-messages 按游标补载。
   */
  hasMoreMessagesAbove?: boolean
}

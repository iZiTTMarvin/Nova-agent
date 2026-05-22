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

/** 单条消息 */
export interface Message {
  id: string
  sessionId: string
  role: MessageRole
  content: string
  toolCalls?: ToolCall[]
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
}

/** Checkpoint manifest（用于回退和文件拒绝） */
export interface CheckpointManifest {
  sessionId: string
  messageId: string
  workspaceRoot: string
  createdFiles: string[]
  modifiedFiles: string[]
  deletedFiles: string[]
  status: 'active' | 'rolled-back'
  createdAt: number
  /** 文件级审查状态，key 为相对路径 */
  fileReviews?: Record<string, 'accepted' | 'rejected'>
}

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

/** 会话摘要（用于列表展示） */
export interface Session {
  id: string
  workspaceRoot: string
  mode: Mode
  createdAt: number
  updatedAt: number
  messageCount: number
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
}

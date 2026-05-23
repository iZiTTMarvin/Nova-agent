/**
 * 会话层类型定义
 *
 * 会话是线性的消息序列，每条用户消息是一个事务边界，
 * 对应一组 checkpoint 和 diff。回退操作从某条消息开始，
 * 删除该消息及之后的所有内容（checkpoint、历史、diff）。
 * 不支持分支或合并。
 */
import type { Mode, MessageBlock } from '../../shared/session'

/** 会话摘要（用于列表展示，不含完整消息） */
export interface SessionSummary {
  id: string
  workspaceRoot: string
  mode: Mode
  createdAt: number
  updatedAt: number
  messageCount: number
}

/** 会话完整数据（含所有消息） */
export interface SessionData {
  id: string
  workspaceRoot: string
  mode: Mode
  messages: SessionMessage[]
  createdAt: number
  updatedAt: number
}

/** 会话中单条消息的持久化格式 */
export interface SessionMessage {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  /** assistant 消息可携带工具调用 */
  toolCalls?: SessionToolCall[]
  /** 顺序块数组，按流式事件顺序排列 */
  blocks?: MessageBlock[]
  /** 工具消息关联的 toolCallId */
  toolCallId?: string
  /** 验证结果摘要（修改后自动验证的结果） */
  verificationSummary?: string
  timestamp: number
}

/** 持久化的工具调用记录 */
export interface SessionToolCall {
  id: string
  name: string
  arguments: string
  result?: string
}

/** 会话持久化文件名 */
export const SESSION_DATA_FILE = 'session.json'

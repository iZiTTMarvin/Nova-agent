/**
 * 会话层类型定义
 *
 * 会话是线性的消息序列，每条用户消息是一个事务边界，
 * 对应一组 checkpoint 和 diff。回退操作从某条消息开始，
 * 删除该消息及之后的所有内容（checkpoint、历史、diff）。
 * 不支持分支或合并。
 */
import type { Mode, MessageBlock } from '../../shared/session'
import type { TodoItem } from '../../shared/todo/types'

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
  /**
   * 会话级冻结的 system prompt（缓存 Harness）
   * 会话创建时生成，整个生命周期内逐字节复用，切模式不改写。
   * 旧会话可能没有此字段，回退到 getStableSystemPrompt() 重新生成。
   */
  frozenSystemPrompt?: string
  /**
   * 会话级 todo 列表（任务外显计划）。
   * 由 todo_write 工具维护，独立于对话历史：上下文压缩对 todo 完全透明。
   * 旧会话没有此字段，反序列化后视为空数组。
   */
  todos?: TodoItem[]
}

/** 可序列化的内容块（与 runtime/model/types.ContentBlock 结构对齐） */
export type SerializableContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

/** 从 string | SerializableContentBlock[] 中提取纯文本 */
export function extractTextFromSerializableContent(
  content: string | SerializableContentBlock[]
): string {
  if (typeof content === 'string') return content
  return content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map(b => b.text)
    .join('\n')
}

/** 会话中单条消息的持久化格式 */
export interface SessionMessage {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  /** 消息内容。纯文本为 string，含图片时为 ContentBlock[]（兼容旧会话的 string 格式） */
  content: string | SerializableContentBlock[]
  /** assistant 消息可携带工具调用 */
  toolCalls?: SessionToolCall[]
  /** 顺序块数组，按流式事件顺序排列 */
  blocks?: MessageBlock[]
  /** 工具消息关联的 toolCallId */
  toolCallId?: string
  /** 验证结果摘要（修改后自动验证的结果） */
  verificationSummary?: string
  /**
   * Phase 3：true 表示本条消息是 cancel 中断产生的（由主进程 message-end 事件携带的
   * interrupted 字段写入）。下次加载会话时 UI 仍能区分"已中断"和"已完成"。
   * 普通完成的消息不写此字段，UI 视为未设置即可。
   */
  interrupted?: boolean
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

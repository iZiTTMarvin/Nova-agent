/**
 * 会话层类型定义
 *
 * 会话消息以树形存储（parentId 链 + currentLeafId），激活路径为当前展示与喂模型的线性视图。
 * 回退/编辑重发在后续阶段通过分叉实现，本期先完成数据模型与 active path 派生。
 */
import type { Mode, MessageBlock } from '../../shared/session'
import type { TodoItem } from '../../shared/todo/types'
import type { ToolTruncationMeta } from '../tools/types'
import type { ChatMessage } from '../model/types'
export {
  SESSION_PLACEHOLDER_TITLE,
  SESSION_MIGRATED_EMPTY_TITLE,
  SESSION_TITLE_MAX_LENGTH,
  clampSessionTitle,
  generateSessionTitleFromText
} from '../../shared/session/title'

/** 会话标题来源：占位名 → 自动截取 → 用户手动改名 */
export type SessionTitleSource = 'placeholder' | 'generated' | 'manual'

/** 会话摘要（用于列表展示，不含完整消息） */
export interface SessionSummary {
  id: string
  workspaceRoot: string
  mode: Mode
  createdAt: number
  updatedAt: number
  messageCount: number
  title?: string
  titleSource?: SessionTitleSource
}

/** 会话完整数据（含所有消息） */
export interface SessionData {
  /**
   * 数据结构版本号。旧会话首次加载时由 migrations.ts 迁移补全。
   * 新创建的会话固定写入 CURRENT_SESSION_SCHEMA_VERSION。
   */
  schemaVersion: number
  id: string
  workspaceRoot: string
  mode: Mode
  messages: SessionMessage[]
  /**
   * 当前激活的叶子节点 id。空会话为 null。
   * 下一次 appendMessage 会把新节点的 parentId 设为 currentLeafId。
   */
  currentLeafId: string | null
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
  /** 侧边栏展示的会话标题 */
  title?: string
  /** 标题来源，用于覆盖保护（manual 后不再被自动逻辑改写） */
  titleSource?: SessionTitleSource
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
  /** 父节点 id；顶层节点（森林根）为 null */
  parentId: string | null
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

/** 追加消息入参：parentId 由 SessionStore.appendMessage 根据 currentLeafId 自动写入 */
export type SessionMessageAppend = Omit<SessionMessage, 'parentId'>

/** 持久化的工具调用记录 */
export interface SessionToolCall {
  id: string
  name: string
  arguments: string
  result?: string
  /** 大输出落盘后的 artifact ID，与 ToolResult.artifactId 对齐 */
  artifactId?: string
  /** 截断元数据，供 UI 展示「共 N 行 / 展示 M 行」 */
  truncationMeta?: ToolTruncationMeta
}

/** 会话元数据持久化文件名 */
export const SESSION_DATA_FILE = 'session.json'

/** 会话消息体追加持久化文件名（JSONL，每行一条 SessionMessage） */
export const SESSION_MESSAGES_FILE = 'messages.jsonl'

/** 上下文快照文件名（与 SESSION_DATA_FILE 并列） */
export const SESSION_CONTEXT_SNAPSHOT_FILE = 'context-snapshot.json'

/** 当前快照结构版本；结构变更时 +1，旧版本快照一律丢弃并回退全量重建 */
export const CONTEXT_SNAPSHOT_VERSION = 1

/**
 * 上下文快照 —— 压缩后运行时上下文的派生缓存（非事实源）。
 * 作用：让「每次 SEND_MESSAGE 重建上下文」时直接从压缩态起步，
 * 避免每次都从完整历史重新压缩。坏了/缺失可从 session.messages 重建。
 */
export interface ContextSnapshot {
  /** 结构版本，必须等于 CONTEXT_SNAPSHOT_VERSION 才可用 */
  version: number
  /** 当前生效的对话历史摘要原文（重启/下一次 send 时重新并入 system 前缀） */
  summary: string
  /**
   * 压缩后运行时上下文里「除 system 外」的消息，原样存 ChatMessage[]。
   * 即 compactedContext.filter(m => m.role !== 'system')。
   * 注意：不含 system（system 由当前 frozenSystemPrompt + summary 重新合成）。
   */
  recentMessages: ChatMessage[]
  /**
   * 生成快照时 session.messages 的最后一条消息 id，作为「增量补齐」的锚点。
   * 含义：本快照已经覆盖 session.messages 中截止到该 id 的所有内容。
   */
  lastMessageId: string
  /** 压缩层级，用于恢复 AgentLoop.compactionLevel（软触发冷却/诊断） */
  compactionLevel: number
  /** 生成时间戳，仅排错用 */
  updatedAt: number
}

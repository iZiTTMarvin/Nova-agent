import type { BrowserWindow } from 'electron'
import type { EventBus } from '../../../runtime/agent'
import type { Mode, PermissionPolicy, MessageBlock } from '../../../shared/session/types'

/**
 * 单条流式消息的短期累积状态。
 * 绑定 turn 的 runId / executionGeneration，用于 late-event fencing 与 dispose。
 */
export interface StreamAccumulator {
  blocks: MessageBlock[]
  /**
   * 是否在累积过程中被取消。
   * 一旦置为 true，message_end 时持久化层会剔除"权限拒绝: 用户拒绝"等
   * 由 cancel 路径残留的 tool block。
   */
  cancelled?: boolean
  runId: string
  executionGeneration: number
  sessionId: string
  messageId: string
}

/**
 * 单次 turn 的事件上下文：显式注入 session/message/run identity。
 * Accumulator 只拥有该 turn 的短期状态；SessionStore 仍是持久消息真源。
 */
export interface TurnEventContext {
  mode: Mode
  /** 工具批准策略（验证弹窗：default+ask 才确认） */
  permissionPolicy: PermissionPolicy
  workspaceRoot: string
  sessionsDir: string
  eventBus: EventBus
  getMainWindow: () => BrowserWindow | null
  /** 当前权威 runId；工具边界写入 turnDraft / stream fencing */
  runId?: string
  /** 当前执行 generation；副作用与 late-event fencing */
  executionGeneration?: number
}

export type MessageContext = TurnEventContext

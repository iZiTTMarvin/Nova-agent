/**
 * Agent 层事件和状态类型
 * EventBus 的结构化事件定义，对应 IPC 推送给 renderer 的事件
 */
import type { DiffReviewStatus } from '../../shared/diff/types'

/** Agent 产出的结构化事件 */
export type AgentEvent =
  | { type: 'message_start'; messageId: string }
  | { type: 'thinking_delta'; messageId: string; delta: string }
  | { type: 'text_delta'; messageId: string; delta: string }
  | { type: 'tool_call_start'; messageId: string; toolCallId: string; toolName: string }
  | { type: 'tool_call_delta'; messageId: string; toolCallId: string; argumentsDelta: string }
  | { type: 'tool_call'; messageId: string; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: 'tool_result'; messageId: string; toolCallId: string; toolName: string; result: string }
  | { type: 'permission_request'; messageId: string; requestId: string; toolName: string; args: Record<string, unknown>; riskLevel: 'low' | 'medium' | 'high'; reason: string }
  | {
      type: 'diff_update'
      messageId: string
      /**
       * live：工具执行完后实时发出的占位信号，只携带文件列表和状态，不含 hunks；
       *       前端用于点亮 loading skeleton，不应渲染 +X -Y 统计。
       * final：message_end 后通过 get-message-diffs 主动拉取的最终数据。
       *        emitLiveDiffUpdate 不会再发 final，保留枚举值供未来扩展。
       */
      phase: 'live' | 'final'
      diffs: Array<{ filePath: string; status: 'added' | 'modified' | 'deleted' }>
      reviews: Record<string, DiffReviewStatus>
    }
  | { type: 'verification_permission_request'; messageId: string; requestId: string; command: string }
  | { type: 'verification_permission_cleared'; messageId: string; requestId: string }
  | { type: 'verification_result'; messageId: string; result: string }
  | { type: 'error'; messageId: string; error: string }
  | { type: 'message_end'; messageId: string }

/** 事件监听回调 */
export type AgentEventCallback = (event: AgentEvent) => void

/** AgentLoop 的当前状态 */
export type AgentState = 'idle' | 'running' | 'cancelled' | 'error'

/** AgentLoop 配置 */
export interface AgentLoopConfig {
  /** 系统提示词 */
  systemPrompt?: string
  /** 最大连续工具调用轮数，防止无限循环 */
  maxToolRounds?: number
}

/**
 * Agent 层事件和状态类型
 * EventBus 的结构化事件定义，对应 IPC 推送给 renderer 的事件
 */
import type { DiffReviewStatus } from '../../shared/diff/types'
import type { NormalizedUsage } from '../model/types'
import type { CacheDiagnosticResult } from '../model/cacheDiagnostics'
import type { TodoItem, TodoViewInfo } from '../../shared/todo/types'
import type { RecoveryState } from './RecoveryStateMachine'

/** Hook 系统 9 个固定事件（供 renderer / 扩展监听） */
export type HookEvent =
  | 'onMessageStart'
  | 'beforeAgentStart'
  | 'preChat'
  | 'context'
  | 'preToolUse'
  | 'postToolUse'
  | 'postMessage'
  | 'onError'
  | 'onCancel'

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
  | { type: 'usage'; messageId: string; usage: NormalizedUsage }
  | { type: 'cache_diagnostic'; messageId: string; diagnostic: CacheDiagnosticResult }
  | { type: 'error'; messageId: string; error: string }
  | { type: 'hook_error'; messageId: string; hookEvent: HookEvent; error: string }
  | { type: 'recovery_hint'; messageId: string; hint: string; attempt: number }
  | { type: 'recovery_state'; messageId: string; state: RecoveryState }
  | { type: 'model_switched'; messageId: string; modelId: string; fallbackIndex: number; reason: string }
  | {
      type: 'message_end'
      messageId: string
      /**
       * Phase 3：true 表示本轮 message-end 是由 cancel 触发的（用户主动中断），
       * renderer 据此把消息标记为 interrupted 状态，避免后续操作误判。
       * 正常完成的消息不写此字段，UI 视为未设置即可。
       */
      interrupted?: boolean
    }
  | {
      /**
       * todo 列表更新事件（不参与 AgentLoop 主流程状态机，仅给渲染端订阅）。
       * 由 todo_write 工具在写入 store 后同步 emit；payload 含 view，前端不用再算。
       */
      type: 'todos_updated'
      sessionId: string
      todos: TodoItem[]
      view: TodoViewInfo
    }

/** 事件监听回调 */
export type AgentEventCallback = (event: AgentEvent) => void

/** AgentLoop 的当前状态 */
export type AgentState = 'idle' | 'running' | 'cancelled' | 'error'

/** 6 层 system prompt 结构（见 SystemPromptBuilder） */
export interface SystemPromptLayers {
  agentRole: string
  baseRules?: string
  projectRules?: string | null
  skillContext?: string
  modeInstruction?: string
  toolSummary?: string
}

/** AgentLoop 配置 */
export interface AgentLoopConfig {
  /** 系统提示词（向后兼容：等价于仅设置 agentRole 层） */
  systemPrompt?: string
  /** 6 层 system prompt（优先于 systemPrompt 字符串） */
  systemPromptLayers?: SystemPromptLayers
  /** 最大连续工具调用轮数，防止无限循环 */
  maxToolRounds?: number
  /** 模型最大上下文窗口（tokens），用于计算动态压缩阈值（上限的 80%） */
  contextWindow?: number
  /** 当前模型是否支持图片输入（vision），用于 readTool 决定是否发送图片 */
  supportsVision?: boolean
  /** 全局工具执行策略：parallel 允许并发安全工具并行，sequential 强制顺序执行 */
  toolExecution?: 'parallel' | 'sequential'
  /** 全局最大并发工具数，小于 1 时按 1 处理 */
  maxParallelToolCalls?: number
  /**
   * 压缩回调：上下文压缩完成后触发，携带重建后的完整上下文。
   * agentHandler 通过此回调将压缩态写回 SessionStore，保证跨轮次持久化。
   */
  onCompaction?: (compactedContext: import('../model/types').ChatMessage[]) => void
  /**
   * 是否启用统一 skill 调度（slash inject/fork）。
   * 默认 true；测试或回退旧路径时可设为 false。
   */
  useUnifiedSkillDispatch?: boolean
}

/**
 * Agent 层事件和状态类型
 * EventBus 的结构化事件定义，对应 IPC 推送给 renderer 的事件
 */
import type { DiffReviewStatus } from '../../shared/diff/types'
import type { NormalizedUsage } from '../model/types'
import type { CacheDiagnosticResult } from '../model/cacheDiagnostics'
import type { TodoItem, TodoViewInfo } from '../../shared/todo/types'
import type { RecoveryState } from './recovery/RecoveryStateMachine'
import type { ToolTruncationMeta } from '../tools/types'
import type { AskQuestionItem } from '../../shared/askQuestion/types'

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
  | { type: 'tool_result'; messageId: string; toolCallId: string; toolName: string; result: string; artifactId?: string; truncationMeta?: ToolTruncationMeta }
  | { type: 'permission_request'; messageId: string; requestId: string; toolName: string; args: Record<string, unknown>; riskLevel: 'low' | 'medium' | 'high'; reason: string; commands?: string[]; toolCallIds?: string[] }
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
  | { type: 'usage'; messageId: string; usage: NormalizedUsage; cacheProfileId: string }
  | {
      type: 'context_breakdown'
      sessionId: string
      /** 对应触发该统计的消息 ID;启动/注入历史时可为空字符串 */
      messageId: string
      breakdown: {
        systemPrompt: number
        skills: number
        tools: number
        messages: number
        other: number
      }
      totalEstimated: number
      promptTokensActual: number
      capturedAt: number
      /** 计算时使用的上下文窗口上限(覆盖 store 默认值,例如加载会话时直接计算) */
      contextLimit?: number
    }
  | { type: 'cache_diagnostic'; messageId: string; diagnostic: CacheDiagnosticResult }
  | { type: 'error'; messageId: string; error: string }
  | { type: 'hook_error'; messageId: string; hookEvent: HookEvent; error: string }
  | { type: 'recovery_hint'; messageId: string; hint: string; attempt: number }
  | { type: 'recovery_state'; messageId: string; state: RecoveryState }
  | { type: 'model_switched'; messageId: string; modelId: string; fallbackIndex: number; reason: string }
  /**
   * 某次模型 attempt 失败（将重试或切 fallback）。
   * Renderer / activeStreams 应丢弃该 attempt 的临时流式块，避免与下一次 attempt 文本重复。
   */
  | { type: 'attempt_failed'; messageId: string; attemptId: string; error: string }
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
  | {
      /** askQuestion 工具请求事件，转发到 renderer 展示提问 UI */
      type: 'ask_question_request'
      requestId: string
      questions: AskQuestionItem[]
      /** 可选归属（由 agentHandler 注入后转发） */
      sessionId?: string
      messageId?: string
      runId?: string
      interactionId?: string
      version?: number
    }
  | {
      /** askQuestion 用户回复事件，renderer 收到后清除 pending 状态 */
      type: 'ask_question_resolved'
      requestId: string
    }
  | {
      /** 编排脚本 phase()：阶段切换（compose 进度面板） */
      type: 'workflow_phase'
      runId: string
      /** 发起编排的会话 id；renderer 据此做面板的会话隔离 */
      sessionId?: string
      phase: string
    }
  | {
      /** 编排脚本 log()：脚本日志行 */
      type: 'workflow_log'
      runId: string
      sessionId?: string
      message: string
    }
  | {
      /** 编排 agent() 失败（超时/取消/错误），仅可观测，不中断脚本 */
      type: 'workflow_agent_failed'
      runId: string
      sessionId?: string
      reason: string
    }
  | {
      /** 编排 askUser：阻塞等待用户选择（阶段 E 弹窗；测试可注入 resolver） */
      type: 'workflow_ask_user'
      runId: string
      sessionId?: string
      requestId: string
      question: string
      options: string[]
    }
  | {
      /** 编排任务列表变更（进度面板） */
      type: 'workflow_task_update'
      runId: string
      sessionId?: string
      tasks: unknown[]
    }
  | {
      /** 编排 state.json 快照（进度面板全量同步） */
      type: 'workflow_state'
      runId: string
      sessionId?: string
      state: Record<string, unknown>
    }

/** 事件监听回调 */
export type AgentEventCallback = (event: AgentEvent) => void

/** AgentLoop 的当前状态 */
export type AgentState = 'idle' | 'running' | 'cancelled' | 'error'

/** 7 层 system prompt 结构（见 SystemPromptBuilder；memoryContext 在 projectRules 之后） */
export interface SystemPromptLayers {
  agentRole: string
  baseRules?: string
  projectRules?: string | null
  memoryContext?: string | null
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
  /**
   * skillContext 层正文 token 估算（char/4）。
   * agentHandler 在拼完 skillContext 后算一次传入，AgentLoop 用它把"技能正文"
   * 单独算一桶，而不是从 frozenSystemPrompt 字符串里反向正则切分（脆弱）。
   */
  skillsTokenEstimate?: number
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
   * 压缩回调：上下文压缩完成后触发，携带重建后的完整上下文与元数据。
   * agentHandler 通过此回调将压缩态写入 context-snapshot.json，不修改 session.messages。
   */
  onCompaction?: (
    compactedContext: import('../model/types').ChatMessage[],
    meta: CompactionMeta
  ) => void
  /**
   * 是否启用统一 skill 调度（slash inject/fork）。
   * 默认 true；测试或回退旧路径时可设为 false。
   */
  useUnifiedSkillDispatch?: boolean
  /**
   * 工具调用方言用户覆盖（来自 ModelConfig.toolDialect）。
   * 'auto'/未设置时走 preferredToolDialect 自动判定。
   */
  toolDialectOverride?: 'auto' | 'native' | 'xml'
  /**
   * 会话级缓存路由 key，透传到每次 modelPool.chat 的 ChatOptions.promptCacheKey。
   * 主对话 / 压缩 / 工具子轮共用；本阶段不写 API body。
   */
  promptCacheKey?: string
}

/** 压缩完成时传给 onCompaction 的元数据 */
export interface CompactionMeta {
  /** 模型生成的摘要原文（用于写入快照 summary） */
  summary: string
  /** 压缩层级（写入快照，用于恢复 AgentLoop.compactionLevel） */
  compactionLevel: number
  /** 触发来源，仅诊断用 */
  trigger: 'threshold' | 'overflow' | 'idle'
}

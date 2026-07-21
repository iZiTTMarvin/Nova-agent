/**
 * streamTypes — StreamProcessor 输入/输出契约（PRD §6.3）
 *
 * 本阶段（Phase 1）只定义类型。Phase 2 才实现 StreamProcessor 类，把
 * sendMessage 中 modelPool.chat 起、到兜底解析结束的整段搬入。
 *
 * 设计理念（PRD §0 / 附录 A）：解析下沉到 StreamProcessor——loop 永远只拿
 * 结构化 AssistantMessage。nova 的方言/兜底解析是响应侧最脏的一段，隔离后
 * XML/native 早期分流，杜绝串线，且可独立单测。
 */
import type { ChatMessage, ChatToolCall, ToolDefinition } from '../../model/types'
import type { AgentEvent } from '../types'
import type { AgentContext } from '../core/AgentContext'
import type { ModelClientPool } from '../../model/ModelClientPool'
import type { RecoveryStateMachine } from '../recovery/RecoveryStateMachine'
import type { CacheDiagnostics } from '../../model/cacheDiagnostics'

/**
 * 一轮模型调用 + 流解析 + 重试/降级/溢出压缩后的确定结果。
 *
 * - assistant：成功的 assistant 结果（含兜底解析后的 toolCalls）
 * - retry：已处理重试/降级/溢出压缩，调用方应重跑本轮（对应现状 shouldRetryChat）
 * - cancelled：流被取消
 * - error：终态错误，调用方应 state=error 并结束（不启动 idleTimer）
 */
export type TurnStreamResult =
  | {
      kind: 'assistant'
      assistantContent: string
      toolCalls: ChatToolCall[]
      finishReason: string
      sawUsage: boolean
      /** 本子轮聚合的 reasoning；无 thinking_delta 时省略 */
      reasoningContent?: string
      /** 产生 reasoningContent 的缓存档案 ID */
      reasoningProviderId?: string
    }
  | { kind: 'retry' }
  | { kind: 'cancelled' }
  | { kind: 'error'; error: string }

/**
 * StreamProcessor 的依赖注入契约（PRD §6.3 StreamProcessorDeps）。
 *
 * emit / emitContextBreakdown / runOverflowCompaction 由 Facade 提供，
 * 确保"所有流式事件由 Processor 内部经 deps.emit 发射，时机与现状一致"。
 */
export interface StreamProcessorDeps {
  modelPool: ModelClientPool
  recovery: RecoveryStateMachine
  cacheDiagnostics: CacheDiagnostics
  emit: (event: AgentEvent) => void
  emitContextBreakdown: (messageId: string, promptTokens: number) => void
  /** 溢出压缩回调（由 Facade/compaction 提供，复用 runOverflowCompaction 逻辑） */
  runOverflowCompaction: (mode: 'standard' | 'aggressive') => Promise<boolean>
}

/**
 * StreamProcessor.run 的入参（PRD §6.3）。
 *
 * 单轮重试态（跨 retry 的 modelErrorAttempt / contextOverflowRetryAttempted）
 * 由 Processor 自持，不在入参中传递。
 */
export interface StreamRunParams {
  messageId: string
  chatMessages: ChatMessage[]
  nativeTools: ToolDefinition[] | undefined
  context: AgentContext
  signal: AbortSignal | undefined
}

/**
 * StreamProcessor 契约（PRD §6.3）。
 *
 * Phase 2 实现：内部封装 dialect 策略选择、scanner 生命周期、三层兜底解析、
 * RecoveryStateMachine 重试、FallbackDecider 降级、context_overflow 压缩重试。
 * 所有流式事件由内部经 deps.emit 发射，时机与现状 §4.2 一致。
 *
 * 关键约定（PRD §6.3）：run 返回 retry 等价于现状的 shouldRetryChat=true; continue；
 * 返回 error 等价于现状在流内 return 的终态；返回 assistant 后由 runAgentLoop 接管。
 *
 * 本阶段（Phase 1）仅为类型占位，StreamProcessor 类在 Phase 2 创建。
 */
export interface StreamProcessorLike {
  run(params: StreamRunParams): Promise<TurnStreamResult>
}

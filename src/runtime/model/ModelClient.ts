/**
 * ModelClient 抽象接口
 * 定义模型调用的标准契约，便于测试时 mock 和未来替换模型后端
 */
import type { ChatMessage, ChatEvent, ToolDefinition, ModelClientConfig } from './types'
import type { ReasoningEffort } from '../../shared/config/llmRegistry'
import type { ChatRequestPurpose } from '../../shared/model/types'

export type { ChatRequestPurpose } from '../../shared/model/types'

/** 模型调用时的可选参数 */
export interface ChatOptions {
  /** 只读观测关联，不参与请求序列化或恢复决策。 */
  observation?: {
    logicalRequestId: string
    runId?: string | null
    sessionId?: string | null
  }
  /** 取消信号，触发时中断上游模型请求 */
  abortSignal?: AbortSignal
  /**
   * 仅用于受控内部调用（如上下文压缩）：
   * 允许把 internal 消息的正文发送给模型，但 internal 标记本身仍不会进入 API 请求体。
   */
  includeInternalMessages?: boolean
  /**
   * ModelTransport 超时覆盖（毫秒）。仅测试 / 诊断使用；生产默认见 DEFAULT_TRANSPORT_TIMEOUTS。
   * 字段均为可选，未提供的沿用默认。
   */
  transportTimeouts?: {
    connectMs?: number
    firstByteMs?: number
    idleMs?: number
    totalMs?: number
  }
  /**
   * 会话级 prompt 缓存路由 key（来自 SessionData.cacheRoutingKey）。
   * 仅当 CacheProfile.promptCacheKey === 'session'（kimi/openai）时写入 body.prompt_cache_key。
   * 压缩摘要请求同样携带：会话亲和档案上摘要前缀要与主对话落在同一路由槽位才能命中。
   */
  promptCacheKey?: string
  /**
   * 中性请求用途标记：主对话缺省；受控内部调用（当前仅压缩摘要）显式声明。
   * 仅用于诊断与测试区分请求来源，不影响请求构造，也不豁免缓存告警。
   */
  purpose?: ChatRequestPurpose
  /**
   * 请求级思考强度覆盖（会话级覆盖经此下发）。
   * 缺省时回落到 client config 的模型默认思考强度。
   */
  reasoningEffort?: ReasoningEffort
}

export interface ModelClient {
  /**
   * 发送消息序列并获取流式响应
   * @param messages 对话上下文
   * @param tools 可选的工具定义列表
   * @param options 可选参数（含取消信号）
   * @returns 流式事件序列
   */
  chat(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions
  ): AsyncIterable<ChatEvent>

  /** 更新模型配置（运行时切换模型） */
  updateConfig(config: ModelClientConfig): void
}

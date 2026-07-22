/**
 * ModelClient 抽象接口
 * 定义模型调用的标准契约，便于测试时 mock 和未来替换模型后端
 */
import type { ChatMessage, ChatEvent, ToolDefinition, ModelClientConfig } from './types'

/** 模型调用时的可选参数 */
export interface ChatOptions {
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
   */
  promptCacheKey?: string
  /**
   * 压缩摘要等受控请求：最终 body 与正常对话前缀必然不同，
   * wire_snapshot 诊断应标记为预期 miss，避免污染命中率解读。
   */
  expectedCacheMiss?: boolean
  /**
   * 本轮已禁用的请求能力集合（按 turn 隔离）。
   *
   * 并发模型下不同 turn 共享同一个底层 client 实例，但各自的能力降级状态必须隔离：
   * turn A 触发的降级（如网关拒绝 prompt_cache_key）不应污染 turn B 的请求体。
   * 由 ModelClientPool 为每个 turn 持有一份 Set 并在此透传；
   * 未提供时回退到 client 实例态（单 turn / 测试场景）。
   */
  capabilityDisabled?: Set<string>
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

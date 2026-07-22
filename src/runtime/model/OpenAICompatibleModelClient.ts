/**
 * OpenAI-compatible 模型客户端
 * 通过 fetch 调用兼容 OpenAI Chat Completions API 的模型服务
 * 支持 SSE 流式响应，纯 Node.js 实现，不依赖 Electron
 */
import type { ChatMessage, ChatEvent, ToolDefinition, ModelClientConfig } from './types'
import type { ModelClient, ChatOptions } from './ModelClient'
import { ThinkTagParser } from './ThinkTagParser'
import { normalizeUsage } from './usage'
import { applyCacheMarkers, applyToolCacheMarker, sanitizeToolMessages } from './messageFormat'
import { buildReasoningParams } from './reasoningDialect'
import { isReasoningSourceCompatible } from './reasoningSource'
import { projectMessagesForVision } from './visionProjection'
import { resolveCacheProfile, type CacheMarker, type CacheProfile } from './cacheProfile'
import type { CacheStrategy } from '../../shared/config/types'
import { resolveSupportsVision } from '../../shared/config/types'
import { isContextOverflowError } from '../agent/recovery/contextOverflow'
import { computeWireSnapshot } from './requestFingerprint'
import {
  transportFetch,
  TransportBodyReader,
  transportErrorToChatEvent,
  httpStatusToError,
  formatTransportError,
  readErrorResponseBody
} from './ModelTransport'

/** 会话级可禁用的请求能力（内存态，loop 重建后重新探测） */
type DowngradeCapability = 'prompt_cache_key' | 'reasoning_content' | 'clear_thinking'

export class OpenAICompatibleModelClient implements ModelClient {
  private config: ModelClientConfig
  /**
   * 当前有效缓存档案（含 reasoningReplay / promptCacheKey / marker）。
   * 在构造 / updateConfig / setCacheStrategy 时解析并缓存，请求路径不重算。
   */
  private cacheProfile: CacheProfile
  /** 网关不兼容后禁用的能力；仅内存态，不跨进程持久化 */
  private disabledCapabilities = new Set<DowngradeCapability>()

  constructor(config: ModelClientConfig) {
    this.config = config
    this.cacheProfile = this.resolveProfile(config)
  }

  updateConfig(config: ModelClientConfig): void {
    this.config = config
    this.cacheProfile = this.resolveProfile(config)
  }

  /**
   * 兼容旧 API：显式覆盖 marker，并同步完整 profile。
   * - 'anthropic' → anthropic 档案
   * - 'auto' → 按 URL/modelId 自然归属（不是钉死 generic）；若自然归属带 cache_control 则压成 none
   */
  setCacheStrategy(strategy: CacheStrategy): void {
    this.cacheProfile = resolveCacheProfile(this.config.baseUrl, this.config.modelId, {
      cacheProfile: this.config.cacheProfile,
      cacheStrategy: strategy
    })
  }

  /** 当前 marker（供 applyCacheMarkers）；与 cacheProfile 同步 */
  private get cacheMarker(): CacheMarker {
    return this.cacheProfile.marker
  }

  /** 按当前配置解析完整 CacheProfile（判定集中在 cacheProfile.ts） */
  private resolveProfile(config: ModelClientConfig): CacheProfile {
    return resolveCacheProfile(config.baseUrl, config.modelId, {
      cacheProfile: config.cacheProfile,
      cacheStrategy: config.cacheStrategy
    })
  }

  /** 测试/诊断：当前已禁用的能力集合 */
  getDisabledCapabilities(): ReadonlySet<DowngradeCapability> {
    return this.disabledCapabilities
  }

  async *chat(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions
  ): AsyncIterable<ChatEvent> {
    // baseUrl 应为完整 API 根地址（如 https://api.openai.com/v1），
    // 只需拼接路径后缀 /chat/completions
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`

    // 本轮禁用能力集合：优先用调用方按 turn 透传的（并发隔离），
    // 回退到 client 实例态（网关级永久降级，单 turn / 测试场景）。
    // 降级写入同时写两份：透传集合归该 turn 所有，实例态保留网关永久语义。
    const requestDisabled: Set<DowngradeCapability> = options?.capabilityDisabled
      ? new Set(options.capabilityDisabled as Iterable<DowngradeCapability>)
      : new Set(this.disabledCapabilities)

    // 默认过滤 internal 消息，避免把运行时临时提示暴露给普通对话；
    // 只有像 compaction 这样的受控内部调用，才会显式放行 internal 正文。
    const selectedMessages = options?.includeInternalMessages
      ? messages
      : messages.filter(m => !m.internal)
    // 发送前强制工具调用配对不变量：丢弃孤立 tool、剥离缺响应的 tool_calls。
    // OpenAI 严格后端（DeepSeek 等）要求每个 tool 消息都有前置配对的 assistant.tool_calls，
    // 否则报 400。共享历史可能因 abort 残留、压缩边界、跨 provider 切换产生孤立消息，
    // 这里统一规整以覆盖所有来源。详见 sanitizeToolMessages 注释。
    const pairedMessages = sanitizeToolMessages(selectedMessages)
    // 按当前模型视觉能力投影：非视觉剥离 image_url；MiMo 等把 tool 多模态提升为后续 user。
    // 只改 API 字节流，不碰 SessionStore——换视觉模型后历史图可恢复。
    const supportsVision = resolveSupportsVision(this.config.modelId, this.config.supportsVision)
    const projectedMessages = projectMessagesForVision(pairedMessages, {
      supportsVision,
      modelId: this.config.modelId,
      baseUrl: this.config.baseUrl
    })
    const apiMessages = projectedMessages.map(m => this.toApiMessage(m, requestDisabled, true))
    const markedMessages = applyCacheMarkers(apiMessages, this.cacheMarker)
      .map(msg => this.stripInternalMarker(msg))

    const body: Record<string, unknown> = {
      model: this.config.modelId,
      messages: markedMessages,
      stream: true,
      stream_options: { include_usage: true }
    }

    // 思考参数：GLM 在 auto 时也注入保留式思考；能力降级后再剥离 clear_thinking
    const reasoningParams = buildReasoningParams(
      this.config.modelId,
      this.config.baseUrl,
      this.config.reasoningEffort ?? 'auto'
    )
    if (reasoningParams) {
      Object.assign(body, this.applyThinkingCapabilityFilter(reasoningParams, requestDisabled))
    }

    if (tools && tools.length > 0) {
      const rawTools = tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters
        }
      }))
      body.tools = applyToolCacheMarker(rawTools, this.cacheMarker)
    }

    // 白名单：仅 kimi/openai（promptCacheKey==='session'）且 options 有 key、且未禁用时注入
    const canInjectPromptCacheKey =
      this.cacheProfile.promptCacheKey === 'session' &&
      !!options?.promptCacheKey &&
      !requestDisabled.has('prompt_cache_key')
    if (canInjectPromptCacheKey) {
      body.prompt_cache_key = options!.promptCacheKey
    }

    // 最终 body 就绪后计算语义快照（降级重试若剥离 key 会在成功/失败出口再算）
    const snapshotEvent = (): ChatEvent => ({
      type: 'wire_snapshot',
      snapshot: computeWireSnapshot(body, this.cacheProfile),
      ...(options?.expectedCacheMiss ? { expectedMiss: true } : {})
    })

    let response: Response
    let attempt: Awaited<ReturnType<typeof transportFetch>>['attempt']
    const doFetch = async (): Promise<{
      response: Response
      attempt: Awaited<ReturnType<typeof transportFetch>>['attempt']
    }> => {
      return transportFetch({
        url,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`
        },
        body: JSON.stringify(body),
        userSignal: options?.abortSignal,
        timeouts: options?.transportTimeouts
      })
    }

    try {
      const result = await doFetch()
      response = result.response
      attempt = result.attempt
    } catch (err) {
      yield snapshotEvent()
      yield transportErrorToChatEvent(err)
      return
    }

    if (!response.ok) {
      const text = await readErrorResponseBody(response, attempt, options?.transportTimeouts)
      const downgradeCap =
        response.status === 400 ? detectDowngradeCapability(text, body) : null

      if (downgradeCap && !requestDisabled.has(downgradeCap)) {
        // 写入本轮请求集合（归该 turn 所有，并发隔离）。
        // 实例态只在「调用方未提供 per-request 集合」时才写，
        // 否则会把本 turn 的降级泄漏到共享同一 client 的其它 turn。
        requestDisabled.add(downgradeCap)
        if (!options?.capabilityDisabled) {
          this.disabledCapabilities.add(downgradeCap)
        }
        yield {
          type: 'capability_downgrade',
          capability: downgradeCap,
          detail: text
        }
        applyCapabilityStripToBody(body, downgradeCap)
        try {
          const retry = await doFetch()
          response = retry.response
          attempt = retry.attempt
        } catch (err) {
          yield snapshotEvent()
          yield transportErrorToChatEvent(err)
          return
        }
        if (!response.ok) {
          const retryText = await readErrorResponseBody(
            response,
            attempt,
            options?.transportTimeouts
          )
          yield snapshotEvent()
          if (response.status === 400 && isContextOverflowError(400, retryText)) {
            yield { type: 'context_overflow', rawError: retryText }
          } else {
            yield { type: 'error', error: httpStatusToError(response.status, retryText) }
          }
          return
        }
        // 降级重试成功：继续走下方流式解析
      } else if (response.status === 400 && isContextOverflowError(400, text)) {
        yield snapshotEvent()
        yield { type: 'context_overflow', rawError: text }
        return
      } else {
        yield snapshotEvent()
        yield { type: 'error', error: httpStatusToError(response.status, text) }
        return
      }
    }

    // 成功路径：在流开始前上报最终 body 指纹
    yield snapshotEvent()
    yield { type: 'message_start' }

    // 流式 think 标签解析状态机（处理 content 中的 <think>...</think> 标签）
    const thinkTagParser = new ThinkTagParser()

    // 累积 tool_calls，SSE 每个 chunk 可能只包含部分信息
    const pendingToolCalls = new Map<number, { id: string; name: string; arguments: string }>()
    let finishReason = ''
    /** 末尾 usage chunk 的原始数据（stream_options.include_usage=true 时由服务端发送） */
    let rawUsage: Record<string, unknown> | null = null

    const bodyStream = response.body
    if (!bodyStream) {
      yield { type: 'error', error: formatTransportError('http_fatal', '响应体为空') }
      attempt.dispose()
      return
    }

    // TransportBodyReader：仅语义事件续期，SSE keepalive 不能掩盖模型卡死。
    const bodyReader = new TransportBodyReader(bodyStream, {
      userSignal: options?.abortSignal,
      timeouts: options?.transportTimeouts,
      attempt
    })
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        if (options?.abortSignal?.aborted) {
          break
        }

        let readResult: { done: boolean; value?: Uint8Array }
        try {
          readResult = await bodyReader.read()
        } catch (err) {
          yield transportErrorToChatEvent(err)
          return
        }
        if (readResult.done) break
        const value = readResult.value
        if (!value) continue

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        // 保留最后一行（可能不完整）
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          if (trimmed === 'data: [DONE]') {
            bodyReader.markSemanticEvent()
            continue
          }
          if (!trimmed.startsWith('data: ')) continue

          try {
            const chunk = JSON.parse(trimmed.slice(6))
            const choice = chunk.choices?.[0]
            const delta = choice?.delta
            // 只允许模型可观察的实际进展续期；usage/role/ping 等元数据不算。
            if (
              chunk.error ||
              choice?.finish_reason ||
              delta?.content ||
              delta?.reasoning_content ||
              (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0)
            ) {
              bodyReader.markSemanticEvent()
            }

            // SSE chunk.error：无 choice 时也必须产出明确 error，不能只 mark 后跳过
            if (chunk.error && !choice) {
              const errMsg =
                typeof chunk.error === 'string'
                  ? chunk.error
                  : String(chunk.error?.message ?? JSON.stringify(chunk.error))
              yield { type: 'error', error: errMsg }
              continue
            }

            // 末尾 usage chunk：无 choices 但有 usage 字段
            if (chunk.usage) {
              rawUsage = chunk.usage as Record<string, unknown>
            }

            if (!choice) continue

            finishReason = choice.finish_reason ?? finishReason

            // 思考/推理内容增量（DeepSeek、MiniMax 等模型通过此字段返回内部推理过程）
            if (delta?.reasoning_content) {
              yield { type: 'thinking_delta', delta: delta.reasoning_content }
            }

            // 文本增量（经过 think 标签状态机处理）
            if (delta?.content) {
              for (const seg of thinkTagParser.feed(delta.content)) {
                yield {
                  type: seg.type === 'thinking' ? 'thinking_delta' : 'text_delta',
                  delta: seg.content
                }
              }
            }

            // 工具调用增量
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0
                const existing = pendingToolCalls.get(idx)

                if (tc.id) {
                  // 新的工具调用启动。OpenAI SSE 协议保证第一个带 id 的 chunk
                  // 同时携带 function.name，无须从 existing 兜底取 name/arguments。
                  const name = tc.function?.name ?? ''
                  const initialArgs = tc.function?.arguments ?? ''

                  pendingToolCalls.set(idx, {
                    id: tc.id,
                    name,
                    arguments: initialArgs
                  })

                  // 立刻 emit start，让 UI 提前插入 running 卡片
                  yield {
                    type: 'tool_call_start',
                    toolCallId: tc.id,
                    toolName: name,
                    index: idx
                  }

                  // 第一个 chunk 也可能携带 arguments 片段，一并 yield
                  if (initialArgs) {
                    yield {
                      type: 'tool_call_delta',
                      toolCallId: tc.id,
                      argumentsDelta: initialArgs
                    }
                  }
                } else if (existing) {
                  // 追加 arguments 片段
                  if (tc.function?.arguments) {
                    existing.arguments += tc.function.arguments
                    yield {
                      type: 'tool_call_delta',
                      toolCallId: existing.id,
                      argumentsDelta: tc.function.arguments
                    }
                  }
                  if (tc.function?.name) {
                    existing.name = tc.function.name
                  }
                }
              }
            }
          } catch {
            // 解析失败的 chunk 静默跳过
          }
        }
      }
    } finally {
      bodyReader.release()
    }

    // 如果因为 abort 而退出流读取，发射取消事件而非正常结束
    if (options?.abortSignal?.aborted) {
      yield { type: 'cancelled' }
      return
    }

    // 冲刷 think 标签状态机残留内容
    for (const seg of thinkTagParser.flush()) {
      yield {
        type: seg.type === 'thinking' ? 'thinking_delta' : 'text_delta',
        delta: seg.content
      }
    }

    // 发射完整的 tool_call 事件
    for (const [, tc] of pendingToolCalls) {
      yield {
        type: 'tool_call',
        toolCall: {
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments
        }
      }
    }

    // 发射归一化的 token 用量（在 message_end 之前，确保下游能关联到本轮）
    if (rawUsage) {
      const usage = normalizeUsage(rawUsage)
      if (usage) {
        yield { type: 'usage', usage }
      }
    }

    yield { type: 'message_end', finishReason: finishReason || 'stop' }
  }

  /**
   * 将内部消息格式转为 API 请求格式。
   *
   * preserveInternal=true 时仅在本地缓存标记阶段保留 internal 元数据，
   * 之后会在真正发请求前统一剥离，不污染 API 字节流。
   *
   * reasoning_content 按 cacheProfile.reasoningReplay 白名单输出，并做来源门控：
   * - tool-call-history（deepseek）：仅含 tool_calls 的 assistant
   * - all-history（kimi / glm）：全部有 reasoningContent 的 assistant
   * - none：绝不输出（即使 ChatMessage 上有值）
   * - 跨档案 / 已禁用 reasoning_content：不输出
   */
  private toApiMessage(
    msg: ChatMessage,
    disabled: Set<DowngradeCapability>,
    preserveInternal = false
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {
      role: msg.role,
      content: msg.content
    }

    if (preserveInternal && msg.internal === true) {
      result.internal = true
    }
    if (preserveInternal && msg.skipCacheMarker === true) {
      result.skipCacheMarker = true
    }

    if (msg.toolCalls && msg.toolCalls.length > 0) {
      result.tool_calls = msg.toolCalls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: tc.arguments
        }
      }))
    }

    if (msg.toolCallId) {
      result.tool_call_id = msg.toolCallId
    }

    // 仅 assistant 消息可带 reasoning_content；按 profile 白名单 + 来源门控决定是否输出
    if (
      msg.role === 'assistant' &&
      msg.reasoningContent !== undefined &&
      !disabled.has('reasoning_content') &&
      isReasoningSourceCompatible(msg.reasoningProviderId, this.cacheProfile.id)
    ) {
      const replay = this.cacheProfile.reasoningReplay
      if (replay === 'all-history') {
        result.reasoning_content = msg.reasoningContent
      } else if (
        replay === 'tool-call-history' &&
        msg.toolCalls &&
        msg.toolCalls.length > 0
      ) {
        result.reasoning_content = msg.reasoningContent
      }
      // reasoningReplay === 'none'：剥离，不写字段
    }

    return result
  }

  /** 在真正发请求前剥离 internal / skipCacheMarker 等本地标记，避免污染 API 消息字节。 */
  private stripInternalMarker(msg: Record<string, unknown>): Record<string, unknown> {
    const { internal: _internal, skipCacheMarker: _skip, ...rest } = msg
    if (!('internal' in msg) && !('skipCacheMarker' in msg)) {
      return msg
    }
    return rest
  }

  /** 按本轮禁用标志过滤 thinking 注入参数 */
  private applyThinkingCapabilityFilter(
    params: Record<string, unknown>,
    disabled: Set<DowngradeCapability>
  ): Record<string, unknown> {
    if (!disabled.has('clear_thinking')) return params
    const thinking = params.thinking
    if (!thinking || typeof thinking !== 'object') return params
    const { clear_thinking: _c, ...restThinking } = thinking as Record<string, unknown>
    return { ...params, thinking: restThinking }
  }
}

/** 从 400 错误文案识别应禁用的能力（仅当请求体确实携带对应字段时） */
function detectDowngradeCapability(
  errorText: string,
  body: Record<string, unknown>
): DowngradeCapability | null {
  if (/prompt_cache_key/i.test(errorText) && 'prompt_cache_key' in body) {
    return 'prompt_cache_key'
  }
  if (/clear_thinking/i.test(errorText) && bodyHasClearThinking(body)) {
    return 'clear_thinking'
  }
  if (/reasoning_content/i.test(errorText) && bodyHasReasoningContent(body)) {
    return 'reasoning_content'
  }
  return null
}

function bodyHasClearThinking(body: Record<string, unknown>): boolean {
  const thinking = body.thinking
  return (
    !!thinking &&
    typeof thinking === 'object' &&
    'clear_thinking' in (thinking as Record<string, unknown>)
  )
}

function bodyHasReasoningContent(body: Record<string, unknown>): boolean {
  const messages = body.messages
  if (!Array.isArray(messages)) return false
  return messages.some(
    m =>
      m &&
      typeof m === 'object' &&
      'reasoning_content' in (m as Record<string, unknown>)
  )
}

/** 按能力类型就地剥离 body 中对应字段，供同请求重试 */
function applyCapabilityStripToBody(
  body: Record<string, unknown>,
  capability: DowngradeCapability
): void {
  if (capability === 'prompt_cache_key') {
    delete body.prompt_cache_key
    return
  }
  if (capability === 'clear_thinking') {
    const thinking = body.thinking
    if (thinking && typeof thinking === 'object') {
      const next = { ...(thinking as Record<string, unknown>) }
      delete next.clear_thinking
      body.thinking = next
    }
    return
  }
  if (capability === 'reasoning_content') {
    const messages = body.messages
    if (!Array.isArray(messages)) return
    body.messages = messages.map(m => {
      if (!m || typeof m !== 'object') return m
      const { reasoning_content: _r, ...rest } = m as Record<string, unknown>
      return rest
    })
  }
}

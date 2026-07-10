/**
 * OpenAI-compatible 模型客户端
 * 通过 fetch 调用兼容 OpenAI Chat Completions API 的模型服务
 * 支持 SSE 流式响应，纯 Node.js 实现，不依赖 Electron
 */
import type { ChatMessage, ChatEvent, ToolDefinition, ModelClientConfig, ChatToolCall } from './types'
import type { ModelClient, ChatOptions } from './ModelClient'
import { ThinkTagParser } from './ThinkTagParser'
import { normalizeUsage } from './usage'
import { applyCacheMarkers, applyToolCacheMarker, sanitizeToolMessages } from './messageFormat'
import { buildReasoningParams } from './reasoningDialect'
import { projectMessagesForVision } from './visionProjection'
import { resolveCacheProfile, type CacheMarker, type CacheProfile } from './cacheProfile'
import type { CacheStrategy } from '../../shared/config/types'
import { resolveSupportsVision } from '../../shared/config/types'
import { isContextOverflowError } from '../agent/recovery/contextOverflow'
import { fingerprintFinalRequestBody } from './requestFingerprint'
import {
  transportFetch,
  TransportBodyReader,
  transportErrorToChatEvent,
  httpStatusToError,
  formatTransportError,
  readErrorResponseBody
} from './ModelTransport'

export class OpenAICompatibleModelClient implements ModelClient {
  private config: ModelClientConfig
  /**
   * 当前有效缓存档案（含 reasoningReplay / promptCacheKey / marker）。
   * 在构造 / updateConfig / setCacheStrategy 时解析并缓存，请求路径不重算。
   */
  private cacheProfile: CacheProfile

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

  async *chat(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions
  ): AsyncIterable<ChatEvent> {
    // baseUrl 应为完整 API 根地址（如 https://api.openai.com/v1），
    // 只需拼接路径后缀 /chat/completions
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`

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
    const apiMessages = projectedMessages.map(m => this.toApiMessage(m, true))
    const markedMessages = applyCacheMarkers(apiMessages, this.cacheMarker)
      .map(msg => this.stripInternalMarker(msg))

    const body: Record<string, unknown> = {
      model: this.config.modelId,
      messages: markedMessages,
      stream: true,
      stream_options: { include_usage: true }
    }

    // 思考强度（按 provider 方言注入；'auto'/缺省时 buildReasoningParams 返回 null，零行为变化）
    const reasoningParams = this.config.reasoningEffort
      ? buildReasoningParams(this.config.modelId, this.config.baseUrl, this.config.reasoningEffort)
      : null
    if (reasoningParams) {
      Object.assign(body, reasoningParams)
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

    // 白名单：仅 kimi/openai（promptCacheKey==='session'）且 options 有 key 时注入
    const canInjectPromptCacheKey =
      this.cacheProfile.promptCacheKey === 'session' && !!options?.promptCacheKey
    if (canInjectPromptCacheKey) {
      body.prompt_cache_key = options!.promptCacheKey
    }

    // 最终 body 就绪后生成匿名结构指纹（降级重试若剥离 key 会在成功/失败出口再算）
    const fingerprintEvent = (): ChatEvent => ({
      type: 'request_fingerprint',
      fingerprint: fingerprintFinalRequestBody(body)
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
      yield fingerprintEvent()
      yield transportErrorToChatEvent(err)
      return
    }

    if (!response.ok) {
      const text = await readErrorResponseBody(response, attempt, options?.transportTimeouts)
      // 精确降级：仅 400 + 错误文案含 prompt_cache_key 时，剥离该字段重试一次
      if (
        canInjectPromptCacheKey &&
        response.status === 400 &&
        /prompt_cache_key/i.test(text)
      ) {
        yield {
          type: 'prompt_cache_key_stripped',
          detail: 'gateway rejected prompt_cache_key; retrying once without it'
        }
        delete body.prompt_cache_key
        try {
          const retry = await doFetch()
          response = retry.response
          attempt = retry.attempt
        } catch (err) {
          yield fingerprintEvent()
          yield transportErrorToChatEvent(err)
          return
        }
        if (!response.ok) {
          const retryText = await readErrorResponseBody(
            response,
            attempt,
            options?.transportTimeouts
          )
          yield fingerprintEvent()
          if (response.status === 400 && isContextOverflowError(400, retryText)) {
            yield { type: 'context_overflow', rawError: retryText }
          } else {
            yield { type: 'error', error: httpStatusToError(response.status, retryText) }
          }
          return
        }
        // 降级重试成功：继续走下方流式解析
      } else if (response.status === 400 && isContextOverflowError(400, text)) {
        yield fingerprintEvent()
        yield { type: 'context_overflow', rawError: text }
        return
      } else {
        yield fingerprintEvent()
        yield { type: 'error', error: httpStatusToError(response.status, text) }
        return
      }
    }

    // 成功路径：在流开始前上报最终 body 指纹
    yield fingerprintEvent()
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
   * reasoning_content 按 cacheProfile.reasoningReplay 白名单输出：
   * - tool-call-history（deepseek）：仅含 tool_calls 的 assistant
   * - all-history（kimi）：全部有 reasoningContent 的 assistant
   * - none：绝不输出（即使 ChatMessage 上有值）
   */
  private toApiMessage(msg: ChatMessage, preserveInternal = false): Record<string, unknown> {
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

    // 仅 assistant 消息可带 reasoning_content；按 profile 白名单决定是否输出
    if (msg.role === 'assistant' && msg.reasoningContent !== undefined) {
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
}

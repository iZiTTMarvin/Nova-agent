/**
 * OpenAI-compatible 模型客户端
 * 通过 fetch 调用兼容 OpenAI Chat Completions API 的模型服务
 * 支持 SSE 流式响应，纯 Node.js 实现，不依赖 Electron
 */
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { ChatMessage, ChatEvent, ToolDefinition, ModelClientConfig, DowngradeCapability } from './types'
import { resolveRouteIdentity } from './routeIdentity'
import { deriveTransportDurations, toTransportAttemptMetric } from './transportObservation'
import { metricTransportAttempt, metricUsageReport, recordMetric } from '../../shared/diagnostics/metrics'
import { toUsageReportMetric } from './usage'
import type { ModelClient, ChatOptions } from './ModelClient'
import { ThinkTagParser } from './ThinkTagParser'
import { normalizeUsage } from './usage'
import { applyCacheMarkers, applyToolCacheMarker, sanitizeToolMessages } from './messageFormat'
import { buildReasoningParams } from './reasoningDialect'
import { isReasoningSourceCompatible } from './reasoningSource'
import { projectMessagesForVision } from './visionProjection'
import { resolveCacheProfile, type CacheMarker, type CacheProfile } from './cacheProfile'
import {
  observeReasoningField,
  type ObservedReasoningField
} from './reasoningObservation'
import type { CacheStrategy } from '../../shared/config/types'
import { resolveSupportsVision } from '../../shared/config/types'
import { isContextOverflowError } from '../agent/recovery/contextOverflow'
import { computeWireSnapshot } from './requestFingerprint'
import {
  transportFetch,
  TransportBodyReader,
  transportErrorToChatEvent,
  httpStatusToFailure,
  formatTransportError,
  readErrorResponseBody
} from './ModelTransport'

/** 会话级可禁用的请求能力（内存态，loop 重建后重新探测） */

/**
 * 诊断开关：NOVA_WIRE_DUMP_DIR 指向目录时，把每次出站请求体原样落盘。
 * 仅用于线下取证（含完整 prompt，不含 Authorization）；未设置时零开销。
 */
function dumpWireBody(body: string): void {
  const dir = process.env.NOVA_WIRE_DUMP_DIR
  if (!dir) return
  try {
    mkdirSync(dir, { recursive: true })
    const name = `wire-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`
    writeFileSync(join(dir, name), body, 'utf8')
  } catch {
    /* 诊断落盘失败不影响请求 */
  }
}

export class OpenAICompatibleModelClient implements ModelClient {
  private config: ModelClientConfig
  /**
   * 当前有效缓存档案（含 reasoningReplay / promptCacheKey / marker）。
   * 在构造 / updateConfig / setCacheStrategy 时解析并缓存，请求路径不重算。
   */
  private cacheProfile: CacheProfile
  /** 网关不兼容后禁用的能力；仅内存态，不跨进程持久化 */
  private disabledCapabilities = new Set<DowngradeCapability>()
  /**
   * 观测到的 reasoning 字段名（仅 cacheProfile.reasoningWireObservable=true 时生效）。
   * 初始取 reasoningWire；每次响应观测到实际字段后覆盖（后写覆盖先写）。
   * 不写回静态 cacheProfile 表。
   */
  private observedReasoningField: ObservedReasoningField | undefined

  constructor(config: ModelClientConfig) {
    this.config = config
    this.cacheProfile = this.resolveProfile(config)
    this.initObservedReasoningField()
  }

  updateConfig(config: ModelClientConfig): void {
    this.config = config
    this.cacheProfile = this.resolveProfile(config)
    this.initObservedReasoningField()
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

  /**
   * 初始化观测字段：仅当档案标记 reasoningWireObservable 时启用观测，
   * 初始值取静态 reasoningWire（限定为 reasoning_content / reasoning 两类载体）。
   */
  private initObservedReasoningField(): void {
    if (!this.cacheProfile.reasoningWireObservable) {
      this.observedReasoningField = undefined
      return
    }
    this.observedReasoningField =
      this.cacheProfile.reasoningWire === 'reasoning' ? 'reasoning' : 'reasoning_content'
  }

  /**
   * 回放历史 reasoning 时实际写入的字段名。
   * 可观测档案：用观测值（响应决定），覆盖静态初始；
   * 不可观测档案：用静态 reasoningWire。
   * think-tag 载体不走本方法（直接注回 content）。
   */
  private effectiveReasoningWireField(): 'reasoning_content' | 'reasoning' {
    return this.observedReasoningField ?? 'reasoning_content'
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

    // 网关级禁用能力（直接读实例态）：同一网关对所有请求行为一致，
    // 并发 turn 共享同一底层 client 时共享同一份降级记忆是正确语义。
    const requestDisabled = this.disabledCapabilities

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

    // 思考参数：GLM 在 auto 时也注入保留式思考；能力降级后再剥离 clear_thinking。
    // 请求级覆盖（会话思考强度覆盖）优先于 client config 的模型默认值。
    const reasoningParams = buildReasoningParams(
      this.config.modelId,
      this.config.baseUrl,
      options?.reasoningEffort ?? this.config.reasoningEffort ?? 'auto'
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
      snapshot: computeWireSnapshot(body, this.cacheProfile, JSON.stringify(body)),
      source: { logicalRequestId, physicalAttemptId, routeId: route.routeId, purpose }
    })

    const logicalRequestId = options?.observation?.logicalRequestId ?? randomUUID()
    const purpose = options?.purpose ?? 'main'
    const route = resolveRouteIdentity({ ...this.config, reasoningEffort: options?.reasoningEffort ?? this.config.reasoningEffort, cacheProfile: this.cacheProfile.id })
    let dispatchIndexWithinCall = 0
    let physicalAttemptId = ''
    let observedAttempt: Awaited<ReturnType<typeof transportFetch>>['attempt'] | undefined
    let observedSnapshot: ReturnType<typeof computeWireSnapshot> | undefined
    let observedResponse: Response | undefined
    let rawUsage: Record<string, unknown> | null = null
    let downgrade: DowngradeCapability | null = null
    const reportAttempt = (): void => {
      if (!observedAttempt || !observedSnapshot) return
      const timing = observedAttempt.getTiming()
      const source = { logicalRequestId, physicalAttemptId, routeId: route.routeId, purpose }
      const usage = normalizeUsage(rawUsage)
      metricTransportAttempt({
        ...toTransportAttemptMetric({
          physicalAttemptId, dispatchIndexWithinCall, purpose, route,
          outcome: observedAttempt.getOutcome() ?? 'abandoned',
          timing, durations: deriveTransportDurations(timing),
          wireBodyHash: observedSnapshot.rawBodyHash,
          wireBodyBytes: observedSnapshot.rawBodyBytes,
          canonicalBodyHash: observedSnapshot.exactBodyHash,
          downgrade,
          providerRequestId: observedResponse?.headers.get('x-request-id') ?? null,
          usageReport: usage ? 'reported' : 'missing'
        }, { logicalRequestId }),
        runId: options?.observation?.runId ?? undefined,
        sessionId: options?.observation?.sessionId ?? undefined
      })
      metricUsageReport({ ...toUsageReportMetric(usage, source), physicalAttemptId })
      observedAttempt = undefined
    }

    let response: Response
    let attempt: Awaited<ReturnType<typeof transportFetch>>['attempt']
    const doFetch = async (): Promise<{
      response: Response
      attempt: Awaited<ReturnType<typeof transportFetch>>['attempt']
    }> => {
      reportAttempt()
      dispatchIndexWithinCall++
      physicalAttemptId = randomUUID()
      rawUsage = null
      observedResponse = undefined
      const wireBody = JSON.stringify(body)
      observedSnapshot = computeWireSnapshot(body, this.cacheProfile, wireBody)
      recordMetric('transport.dispatch', { dispatchIndexWithinCall, wireBodyBytes: observedSnapshot.rawBodyBytes }, {
        id: logicalRequestId,
        tags: { physicalAttemptId, routeId: route.routeId, purpose,
          runId: options?.observation?.runId ?? 'unavailable', sessionId: options?.observation?.sessionId ?? 'unavailable',
          wireBodyHash: observedSnapshot.rawBodyHash, canonicalBodyHash: observedSnapshot.exactBodyHash }
      })
      dumpWireBody(wireBody)
      const result = await transportFetch({
        url,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`
        },
        body: wireBody,
        userSignal: options?.abortSignal,
        timeouts: options?.transportTimeouts,
        fetchImpl: this.config.fetchImpl,
        onAttempt: value => { observedAttempt = value }
      })
      observedResponse = result.response
      return result
    }

    try {
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
        reportAttempt()
        downgrade = downgradeCap
        // 可观测档案的 reasoning_content 400：先尝试切换到另一个字段变体，仍失败才降级剥离。
        // 切换而非直接剥离，避免在 provider 其实支持 reasoning（仅字段名不同）时丢失思考链回放。
        const triedFieldSwitch =
          downgradeCap === 'reasoning_content' &&
          this.cacheProfile.reasoningWireObservable &&
          this.trySwitchReasoningField(body, text)

        if (triedFieldSwitch) {
          // 已把 body 中的 reasoning_content 换成 reasoning（或反向），重新请求
          try {
            const retry = await doFetch()
            response = retry.response
            attempt = retry.attempt
          } catch (err) {
            yield snapshotEvent()
            yield transportErrorToChatEvent(err)
            return
          }
          if (response.ok) {
            // 切换成功：response/attempt 已就绪，落入下方公共成功路径（snapshot + message_start）
          } else {
            const retryText = await readErrorResponseBody(
              response,
              attempt,
              options?.transportTimeouts
            )
            // 切换后仍失败 → 降级剥离 reasoning 作为最后手段（计划：仍失败才降级剥离）。
            // 记录到网关级记忆后剥离并重试一次；若剥离重试仍失败则终态 error。
            requestDisabled.add('reasoning_content')
            yield { type: 'capability_downgrade', capability: 'reasoning_content', detail: retryText }
            applyCapabilityStripToBody(body, 'reasoning_content')
            try {
              const stripRetry = await doFetch()
              response = stripRetry.response
              attempt = stripRetry.attempt
            } catch (err) {
              yield snapshotEvent()
              yield transportErrorToChatEvent(err)
              return
            }
            if (!response.ok) {
              const stripText = await readErrorResponseBody(
                response,
                attempt,
                options?.transportTimeouts
              )
              yield snapshotEvent()
              const failure = httpStatusToFailure(response.status, stripText, response.headers)
              yield { type: 'error', error: failure.message, failure }
              return
            }
            // 剥离重试成功：落入下方公共成功路径
          }
        } else {
          // 记录到网关级记忆：后续所有请求不再发送该参数，避免重复 400。
          // 同一底层 client 的并发 turn 共享此记忆（同一网关行为一致）。
          requestDisabled.add(downgradeCap)
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
              const failure = httpStatusToFailure(response.status, retryText, response.headers)
              yield { type: 'error', error: failure.message, failure }
            }
            return
          }
          // 降级重试成功：继续走下方流式解析
        }
      } else if (response.status === 400 && isContextOverflowError(400, text)) {
        yield snapshotEvent()
        yield { type: 'context_overflow', rawError: text }
        return
      } else {
        yield snapshotEvent()
        const failure = httpStatusToFailure(response.status, text, response.headers)
        yield { type: 'error', error: failure.message, failure }
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
              delta?.reasoning ||
              (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0)
            ) {
              bodyReader.markSemanticEvent()
            }

            // SSE chunk.error：无 choice 时也必须产出明确 error，不能只 mark 后跳过。
            // 产出的 error 携带结构化 failure（provider 中段错误默认按可重试瞬态处理，
            // 由 hasNoObservableOutput 门闩决定是否真的重试）。
            if (chunk.error && !choice) {
              const errMsg =
                typeof chunk.error === 'string'
                  ? chunk.error
                  : String(chunk.error?.message ?? JSON.stringify(chunk.error))
              const failure = { kind: 'provider_unavailable', retryable: true, message: errMsg } as const
              yield { type: 'error', error: errMsg, failure }
              continue
            }

            // 末尾 usage chunk：无 choices 但有 usage 字段
            if (chunk.usage) {
              rawUsage = normalizeRawUsageDetails(chunk.usage as Record<string, unknown>)
            }

            if (!choice) continue

            // 协议观测：记录本轮响应实际使用的 reasoning 字段名（覆盖式，后写覆盖先写）
            if (this.cacheProfile.reasoningWireObservable) {
              const observed = observeReasoningField(delta) ?? observeReasoningField(choice?.message)
              if (observed) this.observedReasoningField = observed
            }

            finishReason = choice.finish_reason ?? finishReason

            // 思考/推理内容增量。reasoning 字段名由观测决定（reasoning_content / reasoning 变体）。
            const reasoningDelta =
              typeof delta?.reasoning_content === 'string'
                ? delta.reasoning_content
                : typeof delta?.reasoning === 'string'
                  ? delta.reasoning
                  : undefined
            if (reasoningDelta) {
              yield { type: 'thinking_delta', delta: reasoningDelta }
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
        yield { type: 'usage', usage, source: { logicalRequestId, physicalAttemptId, routeId: route.routeId, purpose } }
      }
    }

    yield { type: 'message_end', finishReason: finishReason || 'stop' }
    } finally {
      reportAttempt()
    }
  }

  /**
   * 将内部消息格式转为 API 请求格式。
   *
   * preserveInternal=true 时仅在本地缓存标记阶段保留 internal 元数据，
   * 之后会在真正发请求前统一剥离，不污染 API 字节流。
   *
   * reasoning 回放按 cacheProfile.reasoningReplay 白名单输出，并做来源门控：
   * - tool-call-history（deepseek）：仅含 tool_calls 的 assistant
   * - all-history（kimi / glm / minimax）：全部有 reasoningContent 的 assistant
   * - none：绝不输出（即使 ChatMessage 上有值）
   * - 跨档案：不输出
   *
   * 回放载体由 cacheProfile.reasoningWire 决定：
   * - 'reasoning_content'：独立字段（已被网关禁用时不输出）
   * - 'think-tag'：注回 content 开头的 <think>…</think>，还原模型原始输出格式
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

    // 仅 assistant 消息可回放 reasoning；按 profile 白名单 + 来源门控决定是否输出
    if (
      msg.role === 'assistant' &&
      msg.reasoningContent !== undefined &&
      isReasoningSourceCompatible(msg.reasoningProviderId, this.cacheProfile.id)
    ) {
      const replay = this.cacheProfile.reasoningReplay
      const shouldReplay =
        replay === 'all-history' ||
        (replay === 'tool-call-history' && !!msg.toolCalls && msg.toolCalls.length > 0)
      // reasoningReplay === 'none'：剥离，不写任何载体
      if (shouldReplay) {
        if (this.cacheProfile.reasoningWire === 'think-tag') {
          // ThinkTagParser 流式解析时剥离了标签，这里逆向还原为模型原始 content 格式
          if (typeof result.content === 'string') {
            result.content = `<think>${msg.reasoningContent}</think>${result.content}`
          }
        } else if (!disabled.has('reasoning_content')) {
          // 载体字段名：可观测档案用观测值（响应决定），否则用静态 reasoningWire。
          // 空串 reasoning 直接写入：JSON.stringify 天然保留空字符串字段，
          // 无需哨兵占位（Nova 的出站序列化路径不会丢弃空串）。
          result[this.effectiveReasoningWireField()] = msg.reasoningContent
        }
      }
    }

    return result
  }

  /** 在真正发请求前剥离 internal / skipCacheMarker / origin 等本地标记，避免污染 API 消息字节。 */
  private stripInternalMarker(msg: Record<string, unknown>): Record<string, unknown> {
    const { internal: _internal, skipCacheMarker: _skip, origin: _origin, ...rest } = msg
    if (!('internal' in msg) && !('skipCacheMarker' in msg) && !('origin' in msg)) {
      return msg
    }
    return rest
  }

  /**
   * 可观测档案的 reasoning 400 降级前置：把 body 中所有消息的 reasoning_content 键
   * 换成 reasoning 变体，并把观测态切到 reasoning。
   * 仅当 body 确实含 reasoning_content 键时返回 true（表示已就地改写，调用方应重新请求）。
   * 失败（body 无该键 / 非数组）返回 false，调用方回退到剥离降级。
   */
  private trySwitchReasoningField(body: Record<string, unknown>, _errorText: string): boolean {
    const messages = body.messages
    if (!Array.isArray(messages)) return false
    const hasKey = messages.some(
      m => m && typeof m === 'object' && 'reasoning_content' in (m as Record<string, unknown>)
    )
    if (!hasKey) return false
    body.messages = messages.map(m => {
      if (!m || typeof m !== 'object') return m
      const { reasoning_content: rc, ...rest } = m as Record<string, unknown>
      if (rc === undefined) return m
      return { ...rest, reasoning: rc }
    })
    this.observedReasoningField = 'reasoning'
    return true
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
/**
 * 补齐 usage 的 prompt_tokens_details.cached_tokens。
 * 部分 provider（如 Kimi）在顶层返回 cached_tokens，但 prompt_tokens_details 缺失该字段，
 * 导致下游按 details 口径读取时拿不到缓存命中数。补齐后保证 NormalizedUsage 与 rawUsage 口径一致。
 * 仅在顶层有 cached_tokens 且 details 缺该字段时补齐，其余原样返回。
 */
function normalizeRawUsageDetails(raw: Record<string, unknown>): Record<string, unknown> {
  if (typeof raw.cached_tokens !== 'number') return raw
  const details =
    typeof raw.prompt_tokens_details === 'object' && raw.prompt_tokens_details !== null
      ? (raw.prompt_tokens_details as Record<string, unknown>)
      : undefined
  if (details && typeof details.cached_tokens === 'number') return raw
  return {
    ...raw,
    prompt_tokens_details: { ...(details ?? {}), cached_tokens: raw.cached_tokens }
  }
}

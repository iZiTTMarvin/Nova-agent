/**
 * StreamProcessor — 模型/流边界
 *
 * 消费一次 modelPool.chat 的完整流，返回确定的 TurnStreamResult。
 * 内部封装：
 * - dialect 策略选择（XML / native）
 * - scanner 生命周期 + processScanEvent
 * - 三层兜底解析（parseXmlToolCalls / parseTextToolCalls / repairEmptyArgsFromContent）
 * - RecoveryStateMachine 重试
 * - FallbackDecider 降级
 * - context_overflow 溢出压缩（调 deps.runOverflowCompaction）
 *
 * 所有流式事件（text_delta / thinking_delta / tool_call* / usage / recovery_* /
 * model_switched / cache_diagnostic / context_breakdown）由内部经 deps.emit 发射，
 * 时机与 payload 与现状 §4.2 逐项一致。
 *
 * 关键约定：
 * - 返回 retry  → 等价现状 shouldRetryChat=true; continue（调用方重跑本轮）
 * - 返回 error  → 等价现状流内 return 的终态（调用方 state=error 并结束，不启动 idleTimer）
 * - 返回 cancelled → 调用方应 cancelled=true 并走 finishMessageRound
 * - 返回 assistant → 调用方接管兜底解析之后的工具执行
 */
import { randomUUID } from 'crypto'
import type { ChatMessage, ChatToolCall, ContentBlock } from '../../model/types'
import { extractTextFromContent } from '../../model/types'
import { resolveCacheProfile } from '../../model/cacheProfile'
import { XmlToolScanner, stripMinimaxArtifacts, parseXmlToolCalls, type XmlScanEvent } from './xmlToolScanner'
import { parseTextToolCalls, stripTextToolCalls } from '../../../shared/tool-call-text-fallback'
import { repairEmptyArgsFromContent } from './nativeArgsRepair'
import { AttemptController } from '../recovery/AttemptController'
import type { RecoveryStateMachine } from '../recovery/RecoveryStateMachine'
import type { ModelClientPool } from '../../model/ModelClientPool'
import type { CacheDiagnostics } from '../../model/cacheDiagnostics'
import type { HookManager } from '../core/HookManager'
import type { AgentEvent } from '../types'
import type { AgentContext } from '../core/AgentContext'
import type { StreamProcessorDeps, StreamRunParams, TurnStreamResult } from './streamTypes'
import { estimateContextTokens } from '../tokenEstimator'
import {
  metricAttemptStart,
  metricAttemptTtft,
  metricAttemptEnd
} from '../../../shared/diagnostics/metrics'

/**
 * StreamProcessor 依赖（除 StreamProcessorDeps 外的运行时依赖）。
 * emit / emitContextBreakdown / runOverflowCompaction 来自 deps；
 * hookManager / modelPool / recovery / cacheDiagnostics 作为构造注入。
 */
export interface StreamProcessorOptions extends StreamProcessorDeps {
  hookManager: HookManager
  /**
   * fallback 切换后同步 dialect 到 AgentContext。
   * 由 AgentLoop 注入，保证按 active provider 重算，不沿用主模型。
   */
  syncToolDialect?: (context: AgentContext) => void
  /**
   * 会话级 promptCacheKey；透传到每次 modelPool.chat，本阶段不写 body。
   */
  promptCacheKey?: string
}

export class StreamProcessor {
  private modelPool: ModelClientPool
  private recovery: RecoveryStateMachine
  private cacheDiagnostics: CacheDiagnostics
  private emit: (event: AgentEvent) => void
  private emitContextBreakdown: (messageId: string, promptTokens: number) => void
  private runOverflowCompaction: (mode: 'standard' | 'aggressive') => Promise<boolean>
  private hookManager: HookManager
  /** 统一 retry/fallback attempt 所有权 */
  private attemptController: AttemptController
  private syncToolDialect: StreamProcessorOptions['syncToolDialect']
  /** 会话路由 key，注入 ChatOptions（不写 API body） */
  private promptCacheKey: string | undefined

  /**
   * 单轮溢出压缩守卫（与 AttemptController 正交）。
   * - contextOverflowRetryAttempted：单轮一次性守卫，新消息开始时重置。
   */
  private contextOverflowRetryAttempted = false
  private contextOverflowRetryCount = 0

  private static readonly MAX_CONTEXT_OVERFLOW_RETRIES = 3

  constructor(opts: StreamProcessorOptions) {
    this.modelPool = opts.modelPool
    this.recovery = opts.recovery
    this.cacheDiagnostics = opts.cacheDiagnostics
    this.emit = opts.emit
    this.emitContextBreakdown = opts.emitContextBreakdown
    this.runOverflowCompaction = opts.runOverflowCompaction
    this.hookManager = opts.hookManager
    this.syncToolDialect = opts.syncToolDialect
    this.promptCacheKey = opts.promptCacheKey
    this.attemptController = new AttemptController({
      recovery: opts.recovery,
      modelPool: opts.modelPool
    })
  }

  /**
   * 重置单轮重试态。由 Facade 在每条新消息开始时调用一次。
   * retry 重跑本轮时不调用——AttemptController 跨 retry 累积计数。
   */
  resetRetryState(): void {
    this.attemptController.reset()
    this.contextOverflowRetryAttempted = false
    this.contextOverflowRetryCount = 0
  }

  /**
   * 消费一次模型调用的完整流，返回确定结果。
   *
   * attempt 所有权在 AttemptController：每次 run 开始 beginAttempt()，
   * error 时 onError() 原子决定 retry / fallback / fail。
   */
  async run(params: StreamRunParams & {
    /** 读取取消态：返回 cancelled 时调用方据此设 cancelled。Processor 不持有 Facade 的 cancelled 字段 */
    isCancelled: () => boolean
    /** 用于 onError hook 触发 + 指数退避 sleep（注入便于测试） */
    sleep: (ms: number) => Promise<void>
  }): Promise<TurnStreamResult> {
    const { messageId, chatMessages, nativeTools, context, signal } = params

    // 每次模型尝试分配唯一 attemptId；恢复预算只由模型错误路径消耗。
    const attemptId = this.attemptController.beginAttempt()
    const attemptStartedAt = Date.now()
    let ttftRecorded = false
    metricAttemptStart(attemptId)
  
    const finish = <T extends TurnStreamResult>(result: T): T => {
      metricAttemptEnd(attemptId, Date.now() - attemptStartedAt, result.kind)
      return result
    }

    const stream = this.modelPool.chat(chatMessages, nativeTools, {
      ...(signal ? { abortSignal: signal } : {}),
      ...(this.promptCacheKey ? { promptCacheKey: this.promptCacheKey } : {})
    })

    let assistantContent = ''
    let rawContent = ''
    /** 本子轮 thinking_delta 聚合缓冲；retry/fallback/cancel 时与正文同步清空 */
    let reasoningContent = ''
    const toolCalls: ChatToolCall[] = []
    let finishReason = ''
    let roundSawUsage = false
    let shouldRetryChat = false

    const dialect = context.dialect
    const scanner = dialect === 'xml' ? new XmlToolScanner() : null
    const scannerIdMap = new Map<string, string>()
    const scannerToolCallIds = new Set<string>()
    const xmlJsonStates = new Map<string, { currentKey: string | null; seenKeys: Set<string> }>()

    /**
     * 处理一条 scanner 事件，转成对应的 AgentEvent 发射。
     * 流式循环内和 flush 后共用（逐字节对标 sendMessage 内联版本）。
     */
    const processScanEvent = (scanEvent: XmlScanEvent): void => {
      switch (scanEvent.type) {
        case 'text': {
          assistantContent += scanEvent.text
          this.emit({ type: 'text_delta', messageId, delta: scanEvent.text })
          break
        }
        case 'toolStart': {
          const toolCallId = `call_${randomUUID()}`
          scannerIdMap.set(scanEvent.id, toolCallId)
          scannerToolCallIds.add(toolCallId)
          xmlJsonStates.set(toolCallId, { currentKey: null, seenKeys: new Set() })
          this.emit({ type: 'tool_call_start', messageId, toolCallId, toolName: scanEvent.name })
          this.emit({ type: 'tool_call_delta', messageId, toolCallId, argumentsDelta: '{' })
          toolCalls.push({ id: toolCallId, name: scanEvent.name, arguments: '{}' })
          finishReason = 'tool_calls'
          break
        }
        case 'toolArgDelta': {
          const toolCallId = scannerIdMap.get(scanEvent.id)!
          const state = xmlJsonStates.get(toolCallId)!
          let fragment = ''
          if (!state.seenKeys.has(scanEvent.key)) {
            if (state.currentKey !== null) fragment += '"'
            const prefix = state.seenKeys.size > 0 ? ',' : ''
            fragment += `${prefix}"${scanEvent.key}":"`
            state.seenKeys.add(scanEvent.key)
            state.currentKey = scanEvent.key
          }
          const escaped = JSON.stringify(scanEvent.delta).slice(1, -1)
          fragment += escaped
          this.emit({ type: 'tool_call_delta', messageId, toolCallId, argumentsDelta: fragment })
          break
        }
        case 'toolEnd': {
          const toolCallId = scannerIdMap.get(scanEvent.id)!
          const state = xmlJsonStates.get(toolCallId)!
          let fragment = ''
          if (state.currentKey !== null) fragment += '"'
          fragment += '}'
          this.emit({ type: 'tool_call_delta', messageId, toolCallId, argumentsDelta: fragment })
          const tc = toolCalls.find(t => t.id === toolCallId)!
          tc.arguments = JSON.stringify(scanEvent.arguments)
          tc.name = scanEvent.name
          this.emit({ type: 'tool_call', messageId, toolCallId, toolName: scanEvent.name, args: scanEvent.arguments })
          xmlJsonStates.delete(toolCallId)
          scannerIdMap.delete(scanEvent.id)
          break
        }
      }
    }

    try {
      for await (const event of stream) {
        if (params.isCancelled()) break

        // 首 token（text / thinking / tool）记 TTFT
        if (
          !ttftRecorded &&
          (event.type === 'text_delta' ||
            event.type === 'thinking_delta' ||
            event.type === 'tool_call_start' ||
            event.type === 'tool_call')
        ) {
          metricAttemptTtft(attemptId, Date.now() - attemptStartedAt)
          ttftRecorded = true
        }

        switch (event.type) {
          case 'thinking_delta':
            // 累积到运行时缓冲；仍透传 UI，不改 thinking block 行为
            reasoningContent += event.delta
            this.emit({ type: 'thinking_delta', messageId, delta: event.delta })
            break

          case 'text_delta':
            if (scanner) {
              rawContent += event.delta
              for (const scanEvent of scanner.feed(event.delta)) {
                processScanEvent(scanEvent)
              }
            } else {
              assistantContent += event.delta
              this.emit({ type: 'text_delta', messageId, delta: event.delta })
            }
            break

          case 'tool_call_start':
            this.emit({ type: 'tool_call_start', messageId, toolCallId: event.toolCallId, toolName: event.toolName })
            break

          case 'tool_call_delta':
            this.emit({ type: 'tool_call_delta', messageId, toolCallId: event.toolCallId, argumentsDelta: event.argumentsDelta })
            break

          case 'tool_call':
            finishReason = 'tool_calls'
            toolCalls.push(event.toolCall)
            this.emit({ type: 'tool_call', messageId, toolCallId: event.toolCall.id, toolName: event.toolCall.name, args: JSON.parse(event.toolCall.arguments || '{}') })
            break

          case 'prompt_cache_key_stripped':
            // 本 client 已精确剥离并重试；只发诊断，不触发 fallback / 工具重跑
            this.emit({
              type: 'cache_diagnostic',
              messageId,
              diagnostic: {
                cacheBreakDetected: true,
                reason: 'prompt_cache_key_unsupported',
                suggestion:
                  '当前网关不支持 prompt_cache_key。可将 cacheProfile 设为 generic，或改用官方 Kimi/OpenAI 端点。'
              }
            })
            break

          case 'request_fingerprint':
            // 匿名结构指纹写入诊断层，不落明文、不发 UI 事件
            this.cacheDiagnostics.recordRequestFingerprint(event.fingerprint)
            break

          case 'cancelled':
            // 模型请求被取消：返回 cancelled，调用方据此设 Facade.cancelled
            return finish({ kind: 'cancelled' })

          case 'context_overflow': {
            // 溢出压缩与 AttemptController 正交：仍用 recovery.classify 取 recovering 态
            const overflowState = this.attemptController.classifyForEmit(event.rawError)
            this.emit({ type: 'recovery_state', messageId, state: overflowState })
            await this.hookManager.trigger({ event: 'onError', messageId, error: event.rawError })

            if (this.contextOverflowRetryCount >= StreamProcessor.MAX_CONTEXT_OVERFLOW_RETRIES) {
              return finish({ kind: 'error', error: event.rawError })
            }
            if (this.contextOverflowRetryAttempted && overflowState.kind === 'failed') {
              return finish({ kind: 'error', error: event.rawError })
            }
            this.contextOverflowRetryCount++
            this.contextOverflowRetryAttempted = true

            if (overflowState.kind === 'recovering') {
              const hint = this.recovery.buildRecoveryHint(overflowState)
              this.emit({
                type: 'recovery_hint',
                messageId,
                hint,
                attempt: this.attemptController.getProviderAttempt()
              })
            }

            const standardOk = await this.runOverflowCompaction('standard')
            if (standardOk) {
              shouldRetryChat = true
              break
            }
            const aggressiveOk = await this.runOverflowCompaction('aggressive')
            if (aggressiveOk) {
              shouldRetryChat = true
              break
            }
            return finish({ kind: 'error', error: event.rawError })
          }

          case 'error': {
            // AttemptController 原子决定 retry / fallback / fail（修复 P0-2）
            const errState = this.attemptController.classifyForEmit(event.error)
            this.emit({ type: 'recovery_state', messageId, state: errState })
            await this.hookManager.trigger({ event: 'onError', messageId, error: event.error })

            const decision = this.attemptController.onError(event.error)
            if (decision.action === 'retry' || decision.action === 'fallback') {
              // 丢弃本 attempt 临时输出，避免与下一次 attempt 文本重复
              this.emit({
                type: 'attempt_failed',
                messageId,
                attemptId,
                error: event.error
              })
              assistantContent = ''
              rawContent = ''
              reasoningContent = ''
              toolCalls.length = 0
              finishReason = ''
            }
            switch (decision.action) {
              case 'retry': {
                this.emit({
                  type: 'recovery_hint',
                  messageId,
                  hint: decision.hint,
                  attempt: decision.attempt
                })
                await params.sleep(decision.backoffMs)
                shouldRetryChat = true
                break
              }
              case 'fallback': {
                // 按新 active provider 重算 dialect + cache 侧已由各 client 自带 profile
                this.syncToolDialect?.(context)
                this.emit({
                  type: 'model_switched',
                  messageId,
                  modelId: decision.modelId,
                  fallbackIndex: decision.fallbackIndex,
                  reason: decision.reason
                })
                shouldRetryChat = true
                break
              }
              case 'recover_context': {
                shouldRetryChat = true
                break
              }
              case 'fail':
                return finish({ kind: 'error', error: decision.error })
            }
            break
          }

          case 'usage':
            roundSawUsage = true
            {
              // 按当前 active provider 解析档案；fallback 切换后归属新 provider，不沿用主模型
              const provider = this.modelPool.getActiveProvider()
              const profile = resolveCacheProfile(provider.baseUrl, provider.modelId, {
                cacheProfile: provider.cacheProfile,
                cacheStrategy: provider.cacheStrategy
              })
              this.emit({
                type: 'usage',
                messageId,
                usage: event.usage,
                cacheProfileId: profile.id
              })
              const diag = this.cacheDiagnostics.checkResponse(
                event.usage.cachedTokens,
                extractTextFromContent(context.messages.find(m => m.role === 'system')?.content ?? ''),
                context.toolRegistry?.getToolDefinitions()
              )
              if (diag.cacheBreakDetected) {
                this.emit({ type: 'cache_diagnostic', messageId, diagnostic: diag })
              }
            }
            this.emitContextBreakdown(messageId, event.usage.promptTokens)
            break

          case 'message_end':
            if (finishReason !== 'tool_calls') {
              finishReason = event.finishReason
            }
            break
        }
      }
    } catch (streamErr) {
      // 流读取抛异常（未 yield ChatEvent.error）→ 规范化后走 AttemptController，不直接 terminal
      if (params.isCancelled() || (streamErr as Error)?.name === 'AbortError') {
        return finish({ kind: 'cancelled' })
      }
      const errMsg = `network_reset: ${(streamErr as Error)?.message ?? String(streamErr)}`
      const errState = this.attemptController.classifyForEmit(errMsg)
      this.emit({ type: 'recovery_state', messageId, state: errState })
      await this.hookManager.trigger({ event: 'onError', messageId, error: errMsg })
      this.emit({ type: 'attempt_failed', messageId, attemptId, error: errMsg })
      assistantContent = ''
      rawContent = ''
      reasoningContent = ''
      toolCalls.length = 0

      const decision = this.attemptController.onError(errMsg)
      switch (decision.action) {
        case 'retry': {
          this.emit({
            type: 'recovery_hint',
            messageId,
            hint: decision.hint,
            attempt: decision.attempt
          })
          await params.sleep(decision.backoffMs)
          return finish({ kind: 'retry' })
        }
        case 'fallback': {
          this.syncToolDialect?.(context)
          this.emit({
            type: 'model_switched',
            messageId,
            modelId: decision.modelId,
            fallbackIndex: decision.fallbackIndex,
            reason: decision.reason
          })
          return finish({ kind: 'retry' })
        }
        case 'recover_context':
          return finish({ kind: 'retry' })
        case 'fail':
          return finish({ kind: 'error', error: decision.error })
      }
    }

    if (params.isCancelled()) return finish({ kind: 'cancelled' })

    if (scanner) {
      for (const scanEvent of scanner.flush()) {
        processScanEvent(scanEvent)
      }
    }

    if (shouldRetryChat) return finish({ kind: 'retry' })

    // ── 三层兜底解析（逐分支对标 sendMessage L1081-1205）──
    this.applyFallbackParse({
      dialect,
      rawContent,
      assistantContentRef: { value: assistantContent },
      toolCalls,
      scannerToolCallIds,
      messageId,
      setAssistantContent: v => {
        assistantContent = v
      },
      setFinishReason: v => {
        finishReason = v
      }
    })

    return finish({
      kind: 'assistant',
      assistantContent,
      toolCalls,
      finishReason,
      sawUsage: roundSawUsage,
      // 仅在有内容时携带，避免无 thinking 的子轮多出空字段
      ...(reasoningContent ? { reasoningContent } : {})
    })
  }

  /**
   * 三层兜底解析（对标 sendMessage L1081-1205）。
   * 抽成方法便于阅读，行为逐字节等价。
   */
  private applyFallbackParse(args: {
    dialect: AgentContext['dialect']
    rawContent: string
    assistantContentRef: { value: string }
    toolCalls: ChatToolCall[]
    scannerToolCallIds: Set<string>
    messageId: string
    setAssistantContent: (v: string) => void
    setFinishReason: (v: string) => void
  }): void {
    const { dialect, rawContent, toolCalls, messageId, setAssistantContent, setFinishReason } = args
    let assistantContent = args.assistantContentRef.value

    const emitSynthetic = (call: { id: string; name: string; arguments: string }, parsedArgs: Record<string, unknown>) => {
      this.emit({ type: 'tool_call_start', messageId, toolCallId: call.id, toolName: call.name })
      this.emit({ type: 'tool_call', messageId, toolCallId: call.id, toolName: call.name, args: parsedArgs })
    }

    if (dialect === 'xml') {
      const xmlParsed = parseXmlToolCalls(stripMinimaxArtifacts(rawContent))
      const newCalls = xmlParsed.toolCalls.filter(call => {
        const callJson = JSON.stringify(call.arguments)
        return !toolCalls.some(tc => tc.name === call.name && tc.arguments === callJson)
      })
      if (newCalls.length > 0) {
        assistantContent = xmlParsed.visibleText
        setAssistantContent(assistantContent)
        setFinishReason('tool_calls')
        for (const call of newCalls) {
          const synthetic: ChatToolCall = { id: `call_${randomUUID()}`, name: call.name, arguments: JSON.stringify(call.arguments) }
          toolCalls.push(synthetic)
          emitSynthetic(synthetic, call.arguments)
        }
      } else if (toolCalls.length === 0) {
        const fallback = parseTextToolCalls(stripMinimaxArtifacts(rawContent))
        if (fallback && fallback.toolCalls.length > 0) {
          assistantContent = fallback.visibleText
          setAssistantContent(assistantContent)
          setFinishReason('tool_calls')
          for (const parsed of fallback.toolCalls) {
            const synthetic: ChatToolCall = { id: `call_${randomUUID()}`, name: parsed.toolName, arguments: JSON.stringify(parsed.arguments) }
            toolCalls.push(synthetic)
            emitSynthetic(synthetic, parsed.arguments)
          }
        }
      }
    } else if (toolCalls.length === 0) {
      const xmlParsed = parseXmlToolCalls(stripMinimaxArtifacts(assistantContent))
      if (xmlParsed.toolCalls.length > 0) {
        assistantContent = xmlParsed.visibleText
        setAssistantContent(assistantContent)
        setFinishReason('tool_calls')
        for (const call of xmlParsed.toolCalls) {
          const synthetic: ChatToolCall = { id: `call_${randomUUID()}`, name: call.name, arguments: JSON.stringify(call.arguments) }
          toolCalls.push(synthetic)
          emitSynthetic(synthetic, call.arguments)
        }
      } else {
        const fallback = parseTextToolCalls(stripMinimaxArtifacts(assistantContent))
        if (fallback && fallback.toolCalls.length > 0) {
          assistantContent = fallback.visibleText
          setAssistantContent(assistantContent)
          setFinishReason('tool_calls')
          for (const parsed of fallback.toolCalls) {
            const synthetic: ChatToolCall = { id: `call_${randomUUID()}`, name: parsed.toolName, arguments: JSON.stringify(parsed.arguments) }
            toolCalls.push(synthetic)
            emitSynthetic(synthetic, parsed.arguments)
          }
        }
      }
    }
  }
}

/**
 * 重新导出兜底解析工具，供 AgentLoop 在拿到 assistant 结果后做
 */
export { repairEmptyArgsFromContent, stripTextToolCalls, estimateContextTokens }

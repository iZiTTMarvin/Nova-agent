/**
 * StreamProcessor — 模型/流边界（PRD §6.3）
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
 * 关键约定（PRD §6.3）：
 * - 返回 retry  → 等价现状 shouldRetryChat=true; continue（调用方重跑本轮）
 * - 返回 error  → 等价现状流内 return 的终态（调用方 state=error 并结束，不启动 idleTimer）
 * - 返回 cancelled → 调用方应 cancelled=true 并走 finishMessageRound
 * - 返回 assistant → 调用方接管兜底解析之后的工具执行
 *
 * 本类由 AgentLoop（Facade）装配，Phase 2 从 sendMessage 内联逻辑抽离而来。
 * 控制流逐分支对标 §4.2 伪代码，任何 emit 时机/payload 改动都会被黄金测试捕获。
 */
import { randomUUID } from 'crypto'
import type { ChatMessage, ChatToolCall, ContentBlock } from '../../model/types'
import { extractTextFromContent } from '../../model/types'
import { XmlToolScanner, stripMinimaxArtifacts, parseXmlToolCalls, type XmlScanEvent } from './xmlToolScanner'
import { parseTextToolCalls, stripTextToolCalls } from '../../../shared/tool-call-text-fallback'
import { repairEmptyArgsFromContent } from './nativeArgsRepair'
import { decideFallback } from '../recovery/FallbackDecider'
import { MAX_RETRY_ATTEMPTS } from '../recovery/RecoveryStateMachine'
import type { RecoveryStateMachine } from '../recovery/RecoveryStateMachine'
import type { ModelClientPool } from '../../model/ModelClientPool'
import type { CacheDiagnostics } from '../../model/cacheDiagnostics'
import type { HookManager } from '../HookManager'
import type { AgentEvent } from '../types'
import type { AgentContext } from '../core/AgentContext'
import type { StreamProcessorDeps, StreamRunParams, TurnStreamResult } from './streamTypes'
import { estimateContextTokens } from '../tokenEstimator'

/**
 * StreamProcessor 依赖（除 StreamProcessorDeps 外的运行时依赖）。
 * emit / emitContextBreakdown / runOverflowCompaction 来自 deps；
 * hookManager / modelPool / recovery / cacheDiagnostics 作为构造注入。
 */
export interface StreamProcessorOptions extends StreamProcessorDeps {
  hookManager: HookManager
}

export class StreamProcessor {
  private modelPool: ModelClientPool
  private recovery: RecoveryStateMachine
  private cacheDiagnostics: CacheDiagnostics
  private emit: (event: AgentEvent) => void
  private emitContextBreakdown: (messageId: string, promptTokens: number) => void
  private runOverflowCompaction: (mode: 'standard' | 'aggressive') => Promise<boolean>
  private hookManager: HookManager

  /**
   * 单轮重试态（PRD §6.3 注释：跨 retry 的 modelErrorAttempt / contextOverflowRetryAttempted
   * 由 Processor 自持）。
   * - modelErrorAttempt：跨 retry 累积（retry 重跑本轮时不重置），仅在新消息开始 / fallback 切换时重置。
   * - contextOverflowRetryAttempted：单轮一次性守卫，新消息开始时重置。
   */
  private modelErrorAttempt = 0
  private contextOverflowRetryAttempted = false

  constructor(opts: StreamProcessorOptions) {
    this.modelPool = opts.modelPool
    this.recovery = opts.recovery
    this.cacheDiagnostics = opts.cacheDiagnostics
    this.emit = opts.emit
    this.emitContextBreakdown = opts.emitContextBreakdown
    this.runOverflowCompaction = opts.runOverflowCompaction
    this.hookManager = opts.hookManager
  }

  /**
   * 重置单轮重试态（等价现状 sendMessage 开头 modelErrorAttempt=0 / contextOverflowRetryAttempted=false）。
   * 由 Facade 在每条新消息开始时调用一次。retry 重跑本轮时不调用——重试计数跨 retry 累积。
   */
  resetRetryState(): void {
    this.modelErrorAttempt = 0
    this.contextOverflowRetryAttempted = false
  }

  /**
   * 消费一次模型调用的完整流，返回确定结果。
   *
   * 重试态所有权（PRD §6.3）：modelErrorAttempt / contextOverflowRetryAttempted 为
   * Processor 单轮态，跨 retry 累积（retry 重跑本轮时不重置）。仅由 Facade 在每条
   * 新消息开始时调用 resetRetryState() 重置一次。fallback 切换时 Processor 内部重置
   * modelErrorAttempt=0（对新模型重新开始重试链）。
   */
  async run(params: StreamRunParams & {
    /** 读取取消态：返回 cancelled 时调用方据此设 cancelled。Processor 不持有 Facade 的 cancelled 字段 */
    isCancelled: () => boolean
    /** 用于 onError hook 触发 + 指数退避 sleep（注入便于测试） */
    sleep: (ms: number) => Promise<void>
  }): Promise<TurnStreamResult> {
    const { messageId, chatMessages, nativeTools, context, signal } = params

    const stream = this.modelPool.chat(chatMessages, nativeTools, signal ? { abortSignal: signal } : undefined)

    let assistantContent = ''
    let rawContent = ''
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

    for await (const event of stream) {
      if (params.isCancelled()) break

      switch (event.type) {
        case 'thinking_delta':
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
          toolCalls.push(event.toolCall)
          this.emit({ type: 'tool_call', messageId, toolCallId: event.toolCall.id, toolName: event.toolCall.name, args: JSON.parse(event.toolCall.arguments || '{}') })
          break

        case 'cancelled':
          // 模型请求被取消：返回 cancelled，调用方据此设 Facade.cancelled
          return { kind: 'cancelled' }

        case 'context_overflow': {
          const overflowState = this.recovery.classify(event.rawError, this.modelErrorAttempt)
          this.emit({ type: 'recovery_state', messageId, state: overflowState })
          await this.hookManager.trigger({ event: 'onError', messageId, error: event.rawError })

          if (this.contextOverflowRetryAttempted && overflowState.kind === 'failed') {
            return { kind: 'error', error: event.rawError }
          }
          this.contextOverflowRetryAttempted = true

          if (overflowState.kind === 'recovering') {
            const hint = this.recovery.buildRecoveryHint(overflowState)
            this.emit({ type: 'recovery_hint', messageId, hint, attempt: this.modelErrorAttempt })
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
          return { kind: 'error', error: event.rawError }
        }

        case 'error': {
          const errState = this.recovery.classify(event.error, this.modelErrorAttempt)
          this.emit({ type: 'recovery_state', messageId, state: errState })
          await this.hookManager.trigger({ event: 'onError', messageId, error: event.error })

          if (errState.kind === 'retrying' && this.recovery.shouldRetry(errState)) {
            this.modelErrorAttempt = errState.attempt
            const hint = this.recovery.buildRecoveryHint(errState)
            this.emit({ type: 'recovery_hint', messageId, hint, attempt: errState.attempt })
            await params.sleep(this.recovery.backoffMs(errState.attempt))
            shouldRetryChat = true
            break
          }

          const fallbackDecision = decideFallback({
            currentError: event.error,
            retryAttempt: this.modelErrorAttempt,
            maxAttempts: MAX_RETRY_ATTEMPTS,
            currentFallbackIndex: this.modelPool.getActiveFallbackIndex(),
            availableFallbackCount: this.modelPool.getFallbackCount()
          })
          if (fallbackDecision.shouldFallback && fallbackDecision.nextFallbackIndex !== undefined) {
            const nextIndex = fallbackDecision.nextFallbackIndex
            this.modelPool.switchToFallback(nextIndex)
            this.modelErrorAttempt = 0
            const provider = this.modelPool.getActiveProvider()
            this.emit({ type: 'model_switched', messageId, modelId: provider.modelId, fallbackIndex: provider.fallbackIndex, reason: fallbackDecision.reason })
            shouldRetryChat = true
            break
          }

          return { kind: 'error', error: event.error }
        }

        case 'usage':
          roundSawUsage = true
          this.emit({ type: 'usage', messageId, usage: event.usage })
          {
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

    if (params.isCancelled()) return { kind: 'cancelled' }

    if (scanner) {
      for (const scanEvent of scanner.flush()) {
        processScanEvent(scanEvent)
      }
    }

    if (shouldRetryChat) return { kind: 'retry' }

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

    return {
      kind: 'assistant',
      assistantContent,
      toolCalls,
      finishReason,
      sawUsage: roundSawUsage
    }
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
 * repairEmptyArgsFromContent（现状 L1235，留在 loop 因其需改写 assistantMsg.content）。
 */
export { repairEmptyArgsFromContent, stripTextToolCalls, estimateContextTokens }

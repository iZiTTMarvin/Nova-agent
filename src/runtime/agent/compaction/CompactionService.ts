import type { ModelClient } from '../../model/ModelClient'
import type { ChatMessage } from '../../model/types'
import { extractTextFromContent } from '../../model/types'
import type { CacheDiagnostics } from '../../model/cacheDiagnostics'
import type { CacheProfile } from '../../model/cacheProfile'
import type { ContextBudgetManager } from '../ContextBudgetManager'
import {
  compactAtBoundary,
  ContextBudgetExceededError,
  resolveProductionBudgetLimits
} from '../ContextBudgetManager'
import type { AgentContext } from '../core/AgentContext'
import type { CompactionMeta } from '../types'
import { CHARS_PER_TOKEN, estimateContextTokens, estimateTokens } from '../tokenEstimator'
import { IdleCompressionTimer } from './IdleCompressionTimer'
import {
  estimateNextRequestTokens,
  measureRequestPayloadChars
} from './estimateNextRequestTokens'
import { selectMidTurnSafeBoundary } from './selectMidTurnSafeBoundary'
import {
  MIN_RECENT_MESSAGES,
  boundSummaryText,
  buildCompactionRequestTail,
  extractPriorSummary,
  getCompactionThreshold,
  rebuildWithCompression,
  shouldScheduleIdleCompaction,
  shouldCompact,
  splitForCompaction,
  stripReasoningContent
} from './compaction'

type CompactionTrigger = CompactionMeta['trigger']
type OverflowMode = 'standard' | 'aggressive'

export interface CompactionServiceOptions {
  context: AgentContext
  modelClient: Pick<ModelClient, 'chat'>
  contextBudgetManager: Pick<ContextBudgetManager, 'enforceInline'>
  cacheDiagnostics: Pick<CacheDiagnostics, 'bumpEpoch' | 'recordWireSnapshot'>
  contextWindow: number
  onCompaction?: (context: ChatMessage[], meta: CompactionMeta) => void
  getIdleCacheProfile: () => Pick<CacheProfile, 'idlePolicy'> | null
}

interface CompactionParts {
  systemPrompt: string
  oldMessages: ChatMessage[]
  recentMessages: ChatMessage[]
  pulledBackMessages: ChatMessage[]
}

/**
 * 上下文压缩执行与压缩生命周期的唯一 owner。
 *
 * Service 直接更新 AgentContext 中的权威 messages 和压缩簿记，不维护平行上下文。
 * active turn 与 idle compaction 使用物理隔离的 AbortController；新消息通过 idle
 * generation 使晚到摘要失去写回资格，不依赖共享数组回滚。
 * mid-turn 复用同一压缩管线，仅新增触发时机；失败时 fail-open，不终止 turn。
 *
 * 摘要请求是一次性旁路调用：不携带会话缓存路由 key。其前缀在压缩完成后即被丢弃，
 * 永远不会再被请求；挂在会话路由槽位上只会产生无法复用的缓存写入，并挤占主对话
 * 的路由亲和。主对话 / 子代理轮次的路由 key 由 StreamProcessor 独占消费。
 */
export class CompactionService {
  private readonly context: AgentContext
  private readonly modelClient: Pick<ModelClient, 'chat'>
  private readonly contextBudgetManager: Pick<ContextBudgetManager, 'enforceInline'>
  private readonly cacheDiagnostics: Pick<CacheDiagnostics, 'bumpEpoch' | 'recordWireSnapshot'>
  private readonly contextWindow: number
  private readonly onCompaction?: (context: ChatMessage[], meta: CompactionMeta) => void
  private readonly getIdleCacheProfile: CompactionServiceOptions['getIdleCacheProfile']
  private readonly idleTimer: IdleCompressionTimer
  private compressingForOverflow = false
  private idleAbortController: AbortController | null = null
  private idleCompactionInProgress = false
  private idleReschedulePending = false
  private idleGeneration = 0
  private disposed = false
  /** 上一次已发出请求的 provider input tokens；冷启动为 undefined */
  private lastRequestInputTokens: number | undefined
  /** 上一次已发出请求的 payload 字符量；与 lastRequestInputTokens 成对 */
  private lastRequestPayloadChars: number | undefined

  constructor(options: CompactionServiceOptions) {
    this.context = options.context
    this.modelClient = options.modelClient
    this.contextBudgetManager = options.contextBudgetManager
    this.cacheDiagnostics = options.cacheDiagnostics
    this.contextWindow = options.contextWindow
    this.onCompaction = options.onCompaction
    this.getIdleCacheProfile = options.getIdleCacheProfile
    this.idleTimer = new IdleCompressionTimer(() => {
      void this.runScheduledIdleCompaction()
    })
  }

  isCompressingForOverflow(): boolean {
    return this.compressingForOverflow
  }

  recordUserTurn(): void {
    this.context.userTurnsSinceCompaction++
    this.updateTokenEstimate()
  }

  updateTokenEstimate(): void {
    this.context.lastEstimatedTokens = estimateContextTokens(this.context.messages)
  }

  /**
   * 记录刚发出的请求锚点：provider 真实 input usage + 当时 payload 字符量。
   * 仅在见到正数 usage 时更新；供下一步 mid-turn 估算使用。
   */
  recordRequestAnchor(inputTokens: number, payloadChars: number): void {
    if (!Number.isFinite(inputTokens) || inputTokens <= 0) return
    this.lastRequestInputTokens = Math.floor(inputTokens)
    this.lastRequestPayloadChars = Math.max(0, Math.floor(payloadChars))
  }

  restoreCompactedContext(
    summary: string,
    recentMessages: ChatMessage[],
    compactionLevel: number
  ): void {
    const systemPrompt = extractTextFromContent(
      this.context.messages.find(message => message.role === 'system')?.content ?? ''
    )
    this.context.messages = rebuildWithCompression(systemPrompt, summary, recentMessages)
    this.context.compactionLevel = compactionLevel
    this.context.userTurnsSinceCompaction = 0
    this.updateTokenEstimate()
    this.cacheDiagnostics.bumpEpoch('compaction')
  }

  async runThresholdCompaction(abortSignal?: AbortSignal): Promise<boolean> {
    if (this.compressingForOverflow || abortSignal?.aborted) return false

    const threshold = getCompactionThreshold(this.contextWindow)
    const currentTokens = estimateContextTokens(this.context.messages)
    const tokensToCompare = Math.max(currentTokens, this.context.lastEstimatedTokens)
    if (!shouldCompact(
      this.context.messages,
      threshold,
      tokensToCompare,
      this.context.userTurnsSinceCompaction
    )) {
      return false
    }

    return this.runCompaction('threshold', abortSignal)
  }

  /**
   * 工具结果写回后、下一次模型请求前：估算 → 超高水位则压缩。
   * 返回 true 表示已压缩；skip / fail-open 均返回 false，调用方继续原投影。
   */
  async runMidTurnCompaction(abortSignal?: AbortSignal): Promise<boolean> {
    if (this.compressingForOverflow || abortSignal?.aborted || this.disposed) return false

    const { highWaterTokens } = resolveProductionBudgetLimits({
      contextWindow: this.contextWindow
    })
    const payloadChars = measureRequestPayloadChars(this.context.messages)
    const estimate = estimateNextRequestTokens({
      ...(this.lastRequestInputTokens !== undefined
        ? { priorUsageTokens: this.lastRequestInputTokens }
        : {}),
      appendedChars: payloadChars - (this.lastRequestPayloadChars ?? payloadChars),
      coldStartChars: payloadChars,
      charsPerToken: CHARS_PER_TOKEN
    })
    if (estimate <= highWaterTokens) {
      return false
    }

    // 权威消息在工具写回后已是完整协议单元；当前无 partial/pin 字段，故不传钩子。
    const nonSystem = this.context.messages.filter(message => message.role !== 'system')
    const boundary = selectMidTurnSafeBoundary(nonSystem, { reserveTailMessages: 1 })
    if (!boundary.ok || boundary.coveredCount < 1) return false

    const oldMessages = nonSystem.slice(0, boundary.coveredCount)
    const recentMessages = nonSystem.slice(boundary.coveredCount)
    if (oldMessages.length === 0) return false

    const systemMessage = this.context.messages.find(message => message.role === 'system')
    const parts: CompactionParts = {
      systemPrompt: extractTextFromContent(systemMessage?.content ?? ''),
      oldMessages,
      recentMessages,
      pulledBackMessages: []
    }

    try {
      const summary = await this.requestSummary(parts, abortSignal)
      if (!summary || abortSignal?.aborted) return false

      if (!this.applyCompactionResult(parts, summary)) return false
      if (abortSignal?.aborted) return false
      this.notifyCompaction(summary, 'mid-turn')
      return true
    } catch {
      return false
    }
  }

  scheduleIdle(): boolean {
    if (this.disposed) return false
    this.idleReschedulePending = false
    this.idleTimer.start()
    return true
  }

  cancelIdle(): void {
    this.idleGeneration++
    this.idleReschedulePending = false
    this.idleTimer.cancel()
    this.idleAbortController?.abort()
  }

  reset(): void {
    this.cancelIdle()
    this.lastRequestInputTokens = undefined
    this.lastRequestPayloadChars = undefined
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelIdle()
  }

  async runOverflowCompaction(
    mode: OverflowMode,
    abortSignal?: AbortSignal
  ): Promise<boolean> {
    if (this.compressingForOverflow || abortSignal?.aborted) return false

    this.compressingForOverflow = true
    try {
      const pullBack = mode === 'aggressive'
        ? Math.max(4, Math.min(
            Math.floor(this.context.messages.length / 2),
            this.context.messages.length - 2,
            64))
        : 1
      const parts = this.splitOverflowContext(pullBack)
      if (parts.oldMessages.length === 0) return false

      const summary = await this.requestSummary(parts, abortSignal)
      if (!summary || abortSignal?.aborted) return false

      if (!this.applyCompactionResult(parts, summary)) return false
      if (abortSignal?.aborted) return false
      this.notifyCompaction(summary, 'overflow')
      return true
    } catch {
      return false
    } finally {
      this.compressingForOverflow = false
    }
  }

  private async runCompaction(
    trigger: Extract<CompactionTrigger, 'threshold' | 'idle'>,
    abortSignal?: AbortSignal,
    canApply: () => boolean = () => true
  ): Promise<boolean> {
    if (abortSignal?.aborted) return false

    const parts = this.splitThresholdContext()
    if (parts.oldMessages.length === 0) return false

    const summary = await this.requestSummary(parts, abortSignal)
    if (!summary || abortSignal?.aborted || !canApply()) return false

    if (!this.applyCompactionResult(parts, summary)) return false
    if (abortSignal?.aborted || !canApply()) return false
    this.notifyCompaction(summary, trigger)
    return true
  }

  private async runScheduledIdleCompaction(): Promise<void> {
    try {
      await this.tryRunScheduledIdleCompaction()
    } catch {
      // 空闲压缩是后台优化；任何异常都不得逃逸为未处理的 Promise rejection。
    }
  }

  private async tryRunScheduledIdleCompaction(): Promise<void> {
    if (this.disposed) return
    if (this.idleCompactionInProgress) {
      this.idleReschedulePending = true
      return
    }

    if (!shouldScheduleIdleCompaction({
      context: this.context.messages,
      contextWindow: this.contextWindow,
      estimatedTokens: this.context.lastEstimatedTokens > 0
        ? this.context.lastEstimatedTokens
        : undefined,
      idleCompactionInProgress: this.idleCompactionInProgress,
      disposed: this.disposed,
      profile: this.getIdleCacheProfile()
    })) {
      return
    }

    const controller = new AbortController()
    const generation = this.idleGeneration
    this.idleAbortController = controller
    this.idleCompactionInProgress = true

    try {
      await this.runCompaction(
        'idle',
        controller.signal,
        () => (
          !this.disposed
          && !controller.signal.aborted
          && this.idleAbortController === controller
          && this.idleGeneration === generation
        )
      )
    } finally {
      if (this.idleAbortController === controller) {
        this.idleAbortController = null
      }
      this.idleCompactionInProgress = false
      if (this.idleReschedulePending && !this.disposed) {
        this.idleReschedulePending = false
        // 旧请求退出后重新等待完整空闲窗口，避免后台摘要刚结束就立即再次消耗模型。
        this.idleTimer.start()
      }
    }
  }

  private splitThresholdContext(): CompactionParts {
    const systemMessage = this.context.messages.find(message => message.role === 'system')
    const { oldMessages, recentMessages } = splitForCompaction(
      this.context.messages,
      MIN_RECENT_MESSAGES
    )
    return {
      systemPrompt: extractTextFromContent(systemMessage?.content ?? ''),
      oldMessages,
      recentMessages,
      pulledBackMessages: []
    }
  }

  private splitOverflowContext(pullBack: number): CompactionParts {
    const systemMessage = this.context.messages.find(message => message.role === 'system')
    const { oldMessages, recentMessages, pulledBackMessages } = splitForCompaction(
      this.context.messages,
      MIN_RECENT_MESSAGES + pullBack,
      pullBack
    )
    return {
      systemPrompt: extractTextFromContent(systemMessage?.content ?? ''),
      oldMessages,
      recentMessages,
      pulledBackMessages
    }
  }

  private async requestSummary(
    parts: CompactionParts,
    abortSignal?: AbortSignal
  ): Promise<string | null> {
    if (abortSignal?.aborted) return null

    const systemMessage = this.context.messages.find(message => message.role === 'system')
    const { messages: governedOld } = compactAtBoundary(parts.oldMessages)
    // 二次及以后压缩时 system 尾部已含前序摘要，显式注入压缩输入要求增量更新
    const priorSummary = extractPriorSummary(extractTextFromContent(systemMessage?.content ?? ''))
    const compactionContext: ChatMessage[] = [
      ...(systemMessage ? [systemMessage] : []),
      ...stripReasoningContent(governedOld),
      ...buildCompactionRequestTail(
        governedOld[governedOld.length - 1]?.role,
        parts.recentMessages.length,
        priorSummary
      )
    ]

    let summary = ''
    try {
      const stream = this.modelClient.chat(compactionContext, undefined, {
        abortSignal,
        includeInternalMessages: true,
        expectedCacheMiss: true
      })
      for await (const event of stream) {
        if (abortSignal?.aborted) return null
        if (event.type === 'text_delta') {
          summary += event.delta
        } else if (event.type === 'wire_snapshot') {
          this.cacheDiagnostics.recordWireSnapshot(event.snapshot, { expectedMiss: true })
        } else if (
          event.type === 'context_overflow'
          || event.type === 'error'
          || event.type === 'cancelled'
        ) {
          return null
        }
      }
    } catch {
      return null
    }

    const trimmed = summary.trim()
    if (!trimmed) return null
    return boundSummaryText(trimmed)
  }

  /**
   * 采纳摘要并重建上下文。
   * 返回 false 表示摘要未通过采纳校验（替换后总量不小于压缩前），
   * 本次压缩放弃写回，原上下文与簿记保持不变（fail-open，不终止 turn）。
   */
  private applyCompactionResult(parts: CompactionParts, summary: string): boolean {
    // 采纳校验：替换后总量必须严格小于压缩前，否则摘要没有压缩收益。
    // 两侧保留区相同，等价于摘要必须小于被折叠的 oldMessages；按完整两侧计算便于阅读。
    const keptTokens =
      estimateContextTokens(parts.recentMessages) + estimateContextTokens(parts.pulledBackMessages)
    const projectedTokens = estimateTokens(summary) + keptTokens
    const originalTokens = estimateContextTokens(parts.oldMessages) + keptTokens
    if (projectedTokens >= originalTokens) return false

    const rebuilt = rebuildWithCompression(
      parts.systemPrompt,
      summary,
      parts.recentMessages,
      parts.pulledBackMessages
    )
    const budget = this.contextBudgetManager.enforceInline(rebuilt)
    if (budget.status === 'requires_compaction') {
      throw new ContextBudgetExceededError(budget.estimatedTokens, budget.serializedBytes, true)
    }

    this.context.messages = rebuilt
    this.context.compactionLevel++
    this.context.userTurnsSinceCompaction = 0
    this.updateTokenEstimate()
    this.cacheDiagnostics.bumpEpoch('compaction')
    return true
  }

  private notifyCompaction(summary: string, trigger: CompactionTrigger): void {
    this.onCompaction?.(this.context.messages, {
      summary,
      compactionLevel: this.context.compactionLevel,
      trigger
    })
  }
}

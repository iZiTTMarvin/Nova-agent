import type { ModelClient } from '../../model/ModelClient'
import type { ChatMessage } from '../../model/types'
import { extractTextFromContent } from '../../model/types'
import type { CacheDiagnostics } from '../../model/cacheDiagnostics'
import type { CacheProfile } from '../../model/cacheProfile'
import type { ContextBudgetManager } from '../ContextBudgetManager'
import { compactAtBoundary, ContextBudgetExceededError } from '../ContextBudgetManager'
import type { AgentContext } from '../core/AgentContext'
import type { CompactionMeta } from '../types'
import { estimateContextTokens } from '../tokenEstimator'
import { IdleCompressionTimer } from './IdleCompressionTimer'
import {
  MIN_RECENT_MESSAGES,
  buildCompactionRequestTail,
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
  promptCacheKey?: string
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
 */
export class CompactionService {
  private readonly context: AgentContext
  private readonly modelClient: Pick<ModelClient, 'chat'>
  private readonly contextBudgetManager: Pick<ContextBudgetManager, 'enforceInline'>
  private readonly cacheDiagnostics: Pick<CacheDiagnostics, 'bumpEpoch' | 'recordWireSnapshot'>
  private readonly contextWindow: number
  private readonly promptCacheKey?: string
  private readonly onCompaction?: (context: ChatMessage[], meta: CompactionMeta) => void
  private readonly getIdleCacheProfile: CompactionServiceOptions['getIdleCacheProfile']
  private readonly idleTimer: IdleCompressionTimer
  private compressingForOverflow = false
  private idleAbortController: AbortController | null = null
  private idleCompactionInProgress = false
  private idleReschedulePending = false
  private idleGeneration = 0
  private disposed = false

  constructor(options: CompactionServiceOptions) {
    this.context = options.context
    this.modelClient = options.modelClient
    this.contextBudgetManager = options.contextBudgetManager
    this.cacheDiagnostics = options.cacheDiagnostics
    this.contextWindow = options.contextWindow
    this.promptCacheKey = options.promptCacheKey
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

      this.applyCompactionResult(parts, summary)
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

    this.applyCompactionResult(parts, summary)
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
    const compactionContext: ChatMessage[] = [
      ...(systemMessage ? [systemMessage] : []),
      ...stripReasoningContent(governedOld),
      ...buildCompactionRequestTail(
        governedOld[governedOld.length - 1]?.role,
        parts.recentMessages.length
      )
    ]

    let summary = ''
    try {
      const stream = this.modelClient.chat(compactionContext, undefined, {
        abortSignal,
        includeInternalMessages: true,
        expectedCacheMiss: true,
        ...(this.promptCacheKey ? { promptCacheKey: this.promptCacheKey } : {})
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
    return trimmed || null
  }

  private applyCompactionResult(parts: CompactionParts, summary: string): void {
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
  }

  private notifyCompaction(summary: string, trigger: CompactionTrigger): void {
    this.onCompaction?.(this.context.messages, {
      summary,
      compactionLevel: this.context.compactionLevel,
      trigger
    })
  }
}

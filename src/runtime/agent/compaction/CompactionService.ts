import type { ModelClient, ChatOptions } from '../../model/ModelClient'
import type { ChatMessage } from '../../model/types'
import { extractTextFromContent } from '../../model/types'
import type { CacheDiagnostics } from '../../model/cacheDiagnostics'
import type { CacheProfile } from '../../model/cacheProfile'
import type { ContextBudgetManager } from '../ContextBudgetManager'
import { ContextBudgetExceededError, resolveProductionBudgetLimits } from '../ContextBudgetManager'
import type { AgentContext } from '../core/AgentContext'
import type { SummaryProjection } from '../core/projectRequestMessages'
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
  splitForCompaction
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
  /**
   * 空闲压缩的摘要投影：独立缓存投影（取舍见 SummaryProjection 契约——
   * 内容寻址 ID 保证占位符逐字节一致，代价是幂等重写一次 artifact）。
   */
  idleProjection: SummaryProjection
  /**
   * 会话缓存路由 key：会话亲和档案（kimi/openai）上摘要调用与主对话
   * 落在同一路由槽位，前缀对齐才能命中；非亲和档案由客户端白名单忽略。
   */
  promptCacheKey?: string
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
 * 摘要请求回放主对话前缀：输入是调用方传入的投影视图切片（活跃轮次复用主请求
 * 同一归档缓存实例），reasoning 不剥离、由客户端按档案回放策略序列化，会话亲和
 * 档案携带 Cache Routing Key——摘要调用从全价 cache miss 变为服务端前缀命中。
 */
export class CompactionService {
  private readonly context: AgentContext
  private readonly modelClient: Pick<ModelClient, 'chat'>
  private readonly contextBudgetManager: Pick<ContextBudgetManager, 'enforceInline'>
  private readonly cacheDiagnostics: Pick<CacheDiagnostics, 'bumpEpoch' | 'recordWireSnapshot'>
  private readonly contextWindow: number
  private readonly onCompaction?: (context: ChatMessage[], meta: CompactionMeta) => void
  private readonly getIdleCacheProfile: CompactionServiceOptions['getIdleCacheProfile']
  private readonly idleProjection: SummaryProjection
  private readonly promptCacheKey: string | undefined
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
    this.idleProjection = options.idleProjection
    this.promptCacheKey = options.promptCacheKey
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

  async runThresholdCompaction(
    projection: SummaryProjection,
    abortSignal?: AbortSignal
  ): Promise<boolean> {
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

    return this.runCompaction('threshold', projection, abortSignal)
  }

  /**
   * 工具结果写回后、下一次模型请求前：估算 → 超高水位则压缩。
   * 返回 true 表示已压缩；skip / fail-open 均返回 false，调用方继续原投影。
   */
  async runMidTurnCompaction(
    projection: SummaryProjection,
    abortSignal?: AbortSignal
  ): Promise<boolean> {
    if (this.compressingForOverflow || abortSignal?.aborted || this.disposed) return false

    const { highWaterTokens } = resolveProductionBudgetLimits({
      contextWindow: this.contextWindow
    })
    let projectedContext: ChatMessage[]
    try {
      projectedContext = await projection.project(this.context.messages)
    } catch {
      return false
    }
    const payloadChars = measureRequestPayloadChars(projectedContext)
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
      const summary = await this.requestSummary(parts, projection, abortSignal)
      if (!summary || abortSignal?.aborted) return false

      if (!await this.applyCompactionResult(
        parts,
        summary,
        projection,
        () => !abortSignal?.aborted && !this.disposed
      )) return false
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
    projection: SummaryProjection,
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

      const summary = await this.requestSummary(parts, projection, abortSignal)
      if (!summary || abortSignal?.aborted) return false

      if (!await this.applyCompactionResult(
        parts,
        summary,
        projection,
        () => !abortSignal?.aborted && !this.disposed
      )) return false
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
    projection: SummaryProjection,
    abortSignal?: AbortSignal,
    canApply: () => boolean = () => true
  ): Promise<boolean> {
    if (abortSignal?.aborted) return false

    const parts = this.splitThresholdContext()
    if (parts.oldMessages.length === 0) return false

    const summary = await this.requestSummary(parts, projection, abortSignal)
    if (!summary || abortSignal?.aborted || !canApply()) return false

    if (!await this.applyCompactionResult(
      parts,
      summary,
      projection,
      () => !abortSignal?.aborted && !this.disposed && canApply()
    )) return false
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
        this.idleProjection,
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

  /**
   * 构造并发出摘要请求。
   *
   * 摘要输入回放主对话前缀（契约见 SummaryProjection）：对完整权威消息投影后
   * 按切点截取被压缩区域，reasoning 不剥离，压缩指令仅作尾部追加。
   * 摘要调用按普通请求参与缓存诊断，前缀回归触发既有告警。
   */
  private async requestSummary(
    parts: CompactionParts,
    projection: SummaryProjection,
    abortSignal?: AbortSignal
  ): Promise<string | null> {
    if (abortSignal?.aborted) return null

    const systemMessage = this.context.messages.find(message => message.role === 'system')
    const projectedAll = await projection.project(this.context.messages)
    const projectedOld = projectedAll
      .filter(message => message.role !== 'system')
      .slice(0, parts.oldMessages.length)
    // 二次及以后压缩时 system 尾部已含前序摘要，显式注入压缩输入要求增量更新
    const priorSummary = extractPriorSummary(extractTextFromContent(systemMessage?.content ?? ''))
    const compactionContext: ChatMessage[] = [
      ...(systemMessage ? [systemMessage] : []),
      ...projectedOld,
      ...buildCompactionRequestTail(
        projectedOld[projectedOld.length - 1]?.role,
        parts.recentMessages.length,
        priorSummary
      )
    ]

    const chatOptions: ChatOptions = {
      abortSignal,
      includeInternalMessages: true,
      purpose: 'compaction-summary',
      ...(this.promptCacheKey ? { promptCacheKey: this.promptCacheKey } : {})
    }

    let summary = ''
    try {
      const stream = this.modelClient.chat(compactionContext, undefined, chatOptions)
      for await (const event of stream) {
        if (abortSignal?.aborted) return null
        if (event.type === 'text_delta') {
          summary += event.delta
        } else if (event.type === 'wire_snapshot') {
          this.cacheDiagnostics.recordWireSnapshot(event.snapshot, {
            purpose: 'compaction-summary'
          })
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
  private async applyCompactionResult(
    parts: CompactionParts,
    summary: string,
    projection: SummaryProjection,
    canApply: () => boolean = () => true
  ): Promise<boolean> {
    // 采纳校验：替换后总量必须严格小于压缩前，否则摘要没有压缩收益。
    // 两侧保留区相同，等价于摘要必须小于被折叠的 oldMessages；按完整两侧计算便于阅读。
    const keptTokens =
      estimateContextTokens(parts.recentMessages) + estimateContextTokens(parts.pulledBackMessages)
    const projectedTokens = estimateTokens(summary) + keptTokens
    const originalTokens = estimateContextTokens(parts.oldMessages) + keptTokens
    if (projectedTokens >= originalTokens) return false
    if (!canApply()) return false

    const rebuilt = rebuildWithCompression(
      parts.systemPrompt,
      summary,
      parts.recentMessages,
      parts.pulledBackMessages
    )
    const projected = await projection.project(rebuilt)
    if (!canApply()) return false
    const budget = this.contextBudgetManager.enforceInline(projected)
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

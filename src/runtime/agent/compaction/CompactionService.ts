import { measureRequestBudget, type RequestBudgetAnchor, type RequestBudgetMeasurement } from '../../model/requestBudget'
import type { ToolDefinition } from '../../model/types'
import type { ContextBreakdown } from '../../../shared/agent/contextBreakdown'
import type { ModelClient, ChatOptions } from '../../model/ModelClient'
import { randomUUID } from 'crypto'
import type { ChatRequestPurpose, UsageSource } from '../../../shared/model/types'
import { recordMetric, metricUsageAdoption } from '../../../shared/diagnostics/metrics'
import type { ChatMessage, MessageOrigin } from '../../model/types'
import { extractTextFromContent } from '../../model/types'
import type { CacheDiagnostics } from '../../model/cacheDiagnostics'
import type { CacheProfile } from '../../model/cacheProfile'
import type { ContextBudgetManager } from '../ContextBudgetManager'
import { ContextBudgetExceededError, resolveProductionBudgetLimits } from '../ContextBudgetManager'
import { getEffectiveToolDefinitions, type AgentContext } from '../core/AgentContext'
import { collectRequiredFacts, validateHandoff } from './handoffValidation'
import { formatPointerStub } from '../core/renderHandoffPacket'
import type { SummaryProjection } from '../../request-projection'
import type { CompactionMeta } from '../types'
import {
  CONTEXT_SNAPSHOT_VERSION,
  type CompactionLedger,
  type LedgerEntry,
  type LedgerTrigger,
  type StateDoc,
  type StructuredHandoff,
  renderStructuredHandoff,
  extractTextFromSerializableContent,
  type TouchedFilesSnapshot
} from '../../sessions'
import type { BuildConversationContextOptions } from '../../sessions'
import { estimateContextTokens, estimateTokens } from '../tokenEstimator'
import { IdleCompressionTimer } from './IdleCompressionTimer'
import {
  MAX_STUB_ESTIMATED_TOKENS,
  LEDGER_RENDER_WINDOW_RATIO,
  boundSummaryText,
  buildCompactionRequestTail,
  buildRealityLine,
  buildStubPrompt,
  buildStateInstruction,
  foldLedgerEntriesToBudget,
  getStateTokenBudget,
  getTailTokenBudget,
  rebuildWithCompression,
  shouldScheduleIdleCompaction,
  splitForCompactionByTokens,
} from './compaction'

type OverflowMode = 'standard' | 'aggressive'

export interface CompactionServiceOptions {
  context: AgentContext
  modelClient: Pick<ModelClient, 'chat'>
  contextBudgetManager: Pick<ContextBudgetManager, 'enforceInline'>
  cacheDiagnostics: Pick<CacheDiagnostics, 'bumpEpoch' | 'recordWireSnapshot'>
  contextWindow: number
  measureRequest?: (messages: ChatMessage[], tools?: ToolDefinition[]) => RequestBudgetMeasurement
  canWrite?: () => boolean
  getSystemPrompt?: (entryCount: number) => string
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
  /** 按被折叠 messageId 聚合 checkpoint 文件清单；缺省视为无变更 */
  collectTouchedFiles?: (messageIds: readonly string[]) => TouchedFilesSnapshot
  /** 提交瞬间的工作区 / activePlan 路径 */
  getRealityAnchors?: () => { workspacePath: string | null; activePlanPath: string | null }
}

interface CompactionParts {
  oldMessages: ChatMessage[]
  recentMessages: ChatMessage[]
  cutAt: MessageOrigin | null
  authority?: { revision: number; routeId: string; envelopeHash: string; messages: string }
}

interface CompactionOutputs { stub: string | null; state: string; handoff: StructuredHandoff }

/** 管理压缩候选与提交资格；持久化成功后统一发布上下文和缓存纪元。 */
export class CompactionService {
  private historyProjection: BuildConversationContextOptions = {}
  private readonly measureRequest: NonNullable<CompactionServiceOptions['measureRequest']>
  private readonly canWrite: () => boolean
  private budget: ContextBreakdown['budget']
  private readonly context: AgentContext
  private readonly modelClient: Pick<ModelClient, 'chat'>
  private readonly contextBudgetManager: Pick<ContextBudgetManager, 'enforceInline'>
  private readonly cacheDiagnostics: Pick<CacheDiagnostics, 'bumpEpoch' | 'recordWireSnapshot'>
  private readonly getSystemPrompt: CompactionServiceOptions['getSystemPrompt']
  private readonly configuredContextWindow: number
  private get contextWindow(): number { return Math.min(this.configuredContextWindow, this.measureRequest([]).contextWindow) }
  private readonly onCompaction?: (context: ChatMessage[], meta: CompactionMeta) => void
  private readonly getIdleCacheProfile: CompactionServiceOptions['getIdleCacheProfile']
  private readonly idleProjection: SummaryProjection
  private readonly promptCacheKey: string | undefined
  private readonly collectTouchedFiles: CompactionServiceOptions['collectTouchedFiles']
  private readonly getRealityAnchors?: () => { workspacePath: string | null; activePlanPath: string | null }
  private readonly idleTimer: IdleCompressionTimer
  private compressingForOverflow = false
  private idleAbortController: AbortController | null = null
  private idleCompactionInProgress = false
  private idleReschedulePending = false
  private idleGeneration = 0
  private disposed = false
  constructor(options: CompactionServiceOptions) {
    this.measureRequest = options.measureRequest ?? ((messages, tools) => measureRequestBudget({ messages, tools }, 'unknown', options.contextWindow))
    this.canWrite = () => !this.disposed && (options.canWrite?.() ?? true)
    this.context = options.context
    this.modelClient = options.modelClient
    this.contextBudgetManager = options.contextBudgetManager
    this.cacheDiagnostics = options.cacheDiagnostics
    this.getSystemPrompt = options.getSystemPrompt
    this.configuredContextWindow = options.contextWindow
    this.onCompaction = options.onCompaction
    this.getIdleCacheProfile = options.getIdleCacheProfile
    this.idleProjection = options.idleProjection
    this.promptCacheKey = options.promptCacheKey
    this.collectTouchedFiles = options.collectTouchedFiles
    this.getRealityAnchors = options.getRealityAnchors
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

  getBudget(): ContextBreakdown['budget'] { return this.budget ? { ...this.budget } : undefined }

  assessNextRequest(request: RequestBudgetMeasurement): NonNullable<ContextBreakdown['budget']> {
    const contextWindow = Math.min(this.contextWindow, request.contextWindow)
    const threshold = Math.floor(contextWindow * 0.8)
    const { highWaterTokens } = resolveProductionBudgetLimits({ contextWindow })
    const anchor = this.context.compactionState?.budgetAnchor
    const compatible = anchor && anchor.estimatorVersion === 1 && anchor.routeId === request.routeId &&
      anchor.envelopeHash === request.envelopeHash && anchor.messageCount <= request.prefixHashes.length &&
      anchor.prefixHash === request.prefixHashes[anchor.messageCount - 1] && request.serializedBytes >= anchor.serializedBytes
    const deltaBytes = compatible ? request.serializedBytes - anchor.serializedBytes : request.serializedBytes
    // 未知 tokenizer 使用字节保守增量；不把字符差伪装成实际 token 差。
    const marginTokens = compatible && deltaBytes === 0 ? 0 : Math.max(256, Math.ceil(deltaBytes * 0.05))
    const estimatedTokens = (compatible ? anchor.inputTokens : 0) + deltaBytes + marginTokens
    const reason = compatible ? 'compatible-main-anchor' : anchor ? 'incompatible-anchor' : 'no-main-usage'
    const status = !compatible && estimatedTokens > highWaterTokens ? 'blocked'
      : estimatedTokens >= threshold ? 'compact' : 'within'
    this.budget = { status, estimatedTokens, contextWindow, threshold, marginTokens,
      source: compatible ? deltaBytes === 0 ? 'provider' : 'anchored-estimate' : 'conservative-estimate', reason }
    recordMetric('budget.assessment', { estimatedTokens, threshold, contextWindow, marginTokens, serializedBytes: request.serializedBytes,
      revision: this.context.compactionState?.revision ?? 0 }, { id: this.context.runId ?? undefined,
      tags: { status, reason, source: this.budget.source, routeId: request.routeId, tokenizerId: request.tokenizerId, envelopeHash: request.envelopeHash, prefixHash: request.prefixHashes.at(-1) ?? '' } })
    return { ...this.budget }
  }

  observeMainRequest(inputTokens: number, request: RequestBudgetMeasurement, source: UsageSource, expectedRevision = 0): boolean {
    if (!this.canWrite() || source.purpose !== 'main' || source.routeId !== request.routeId ||
        request.routeId !== this.measureRequest([]).routeId ||
        !Number.isSafeInteger(inputTokens) || inputTokens <= 0 || request.prefixHashes.length === 0) return false
    const previous = this.context.compactionState
    const revision = previous?.revision ?? 0
    if (expectedRevision !== revision) return false
    const anchor: RequestBudgetAnchor = { estimatorVersion: 1, revision: revision + 1,
      routeId: request.routeId, envelopeHash: request.envelopeHash, messageCount: request.prefixHashes.length,
      prefixHash: request.prefixHashes.at(-1)!, serializedBytes: request.serializedBytes, inputTokens, source }
    if (this.context.sessionStore && this.context.sessionId &&
        !this.context.sessionStore.saveBudgetAnchor(this.context.sessionId, anchor, revision)) return false
    if (!this.canWrite()) return false
    this.context.compactionState = { ...(previous ?? { version: CONTEXT_SNAPSHOT_VERSION, entries: [], state: null, tailFrom: null, updatedAt: Date.now() }), revision: anchor.revision, budgetAnchor: anchor }
    this.assessNextRequest(request)
    return true
  }

  restoreBudget(ledger: CompactionLedger): void { this.context.compactionState = ledger }

  async prepareMainRequest(messages: ChatMessage[], tools: ToolDefinition[] | undefined, projection: SummaryProjection, signal?: AbortSignal): Promise<{ status: 'within' | 'compacted'; revision: number }> {
    if (!this.canWrite() || signal?.aborted) throw new Error('Request budget authority expired')
    const request = this.measureRequest(messages, tools)
    const budget = this.assessNextRequest(request)
    if (budget.status === 'within') return { status: 'within', revision: this.context.compactionState?.revision ?? 0 }
    if (budget.status === 'blocked') throw new ContextBudgetExceededError(budget.estimatedTokens, request.serializedBytes, false)
    const compacted = await this.runCompaction('threshold', projection, signal, this.canWrite)
    if (!compacted) throw new ContextBudgetExceededError(budget.estimatedTokens, request.serializedBytes, true)
    return { status: 'compacted', revision: this.context.compactionState?.revision ?? 0 }
  }

  restoreCompactedContext(ledger: CompactionLedger, tail: ChatMessage[]): void {
    this.context.messages = rebuildWithCompression(this.context.systemPrompt, ledger, tail)
    this.context.compactionState = ledger
    this.context.compactionLevel = ledger.entries.length
    this.context.userTurnsSinceCompaction = 0
    this.updateTokenEstimate()
    this.cacheDiagnostics.bumpEpoch('compaction')
  }

  async runThresholdCompaction(
    projection: SummaryProjection,
    abortSignal?: AbortSignal
  ): Promise<boolean> {
    if (this.compressingForOverflow || abortSignal?.aborted) return false

    const projected = await projection.project(this.context.messages)
    if (this.assessNextRequest(this.measureRequest(projected)).status === 'within') return false

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

    const projectedContext = await projection.project(this.context.messages)
    if (this.assessNextRequest(this.measureRequest(projectedContext)).status === 'within') return false

    const { oldMessages, recentMessages } = splitForCompactionByTokens(
      this.context.messages,
      getTailTokenBudget(this.contextWindow)
    )
    if (oldMessages.length === 0) return false

    const parts: CompactionParts = {
      oldMessages,
      recentMessages,
      cutAt: recentMessages[0]?.origin ?? null
    }

    const usageSources: UsageSource[] = []
    let adopted = false
    try {
      const outputs = await this.requestCompactionOutputs(parts, projection, abortSignal, usageSources)
      if (!outputs || abortSignal?.aborted) return false

      adopted = await this.applyCompactionResult(
        parts,
        outputs,
        projection,
        'mid-turn',
        () => !abortSignal?.aborted && !this.disposed
      )
      if (!adopted) return false
      this.notifyCompaction('mid-turn')
      return true
    } catch {
      return adopted
    } finally {
      for (const source of usageSources) metricUsageAdoption(source, adopted, 'compaction-context')
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
    this.budget = undefined
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
    const usageSources: UsageSource[] = []
    let adopted = false
    try {
      const extraTailTokens = mode === 'aggressive' ? getTailTokenBudget(this.contextWindow) : 0
      const parts = this.splitOverflowContext(extraTailTokens)
      if (parts.oldMessages.length === 0) return false

      const outputs = await this.requestCompactionOutputs(parts, projection, abortSignal, usageSources)
      if (!outputs || abortSignal?.aborted) return false

      adopted = await this.applyCompactionResult(
        parts,
        outputs,
        projection,
        'overflow',
        () => !abortSignal?.aborted && !this.disposed
      )
      if (!adopted) return false
      this.notifyCompaction('overflow')
      return true
    } catch {
      return adopted
    } finally {
      for (const source of usageSources) metricUsageAdoption(source, adopted, 'compaction-context')
      this.compressingForOverflow = false
    }
  }

  private async runCompaction(
    trigger: Extract<LedgerTrigger, 'threshold' | 'idle'>,
    projection: SummaryProjection,
    abortSignal?: AbortSignal,
    canApply: () => boolean = () => true
  ): Promise<boolean> {
    if (abortSignal?.aborted) return false

    const parts = this.splitThresholdContext()
    if (parts.oldMessages.length === 0) return false

    const usageSources: UsageSource[] = []
    let adopted = false
    try {
      const outputs = await this.requestCompactionOutputs(parts, projection, abortSignal, usageSources)
      if (!outputs || abortSignal?.aborted || !canApply()) return false

      adopted = await this.applyCompactionResult(
        parts,
        outputs,
        projection,
        trigger,
        () => !abortSignal?.aborted && !this.disposed && canApply()
      )
      if (!adopted) return false
      this.notifyCompaction(trigger)
      return true
    } catch (error) {
      recordMetric('compaction.rejected', {}, { tags: { reason: 'candidate-or-persistence-failed', error: error instanceof Error ? error.message : String(error) } })
      return adopted
    } finally {
      for (const source of usageSources) metricUsageAdoption(source, adopted, 'compaction-context')
    }
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
    const { oldMessages, recentMessages } = splitForCompactionByTokens(
      this.context.messages,
      getTailTokenBudget(this.contextWindow)
    )
    return {
      oldMessages,
      recentMessages,
      cutAt: recentMessages[0]?.origin ?? null
    }
  }

  private splitOverflowContext(extraTailTokens: number): CompactionParts {
    const { oldMessages, recentMessages } = splitForCompactionByTokens(
      this.context.messages,
      getTailTokenBudget(this.contextWindow),
      extraTailTokens
    )
    return {
      oldMessages,
      recentMessages,
      cutAt: recentMessages[0]?.origin ?? null
    }
  }

  /**
   * 并行发出 stub / state 两次压缩请求，都回放主对话前缀。
   * state 失败则整轮放弃；stub 失败则降级为代码指针。
   */
  private async requestCompactionOutputs(
    parts: CompactionParts,
    projection: SummaryProjection,
    abortSignal: AbortSignal | undefined,
    usageSources: UsageSource[]
  ): Promise<CompactionOutputs | null> {
    if (abortSignal?.aborted) return null
    const measurement = this.measureRequest(this.context.messages, getEffectiveToolDefinitions(this.context))
    parts.authority = { revision: this.context.compactionState?.revision ?? 0, routeId: measurement.routeId,
      envelopeHash: measurement.envelopeHash, messages: JSON.stringify(this.context.messages) }

    const systemMessage = this.context.messages.find(message => message.role === 'system')
    const projectedAll = await projection.project(this.context.messages)
    const projectedOld = projectedAll
      .filter(message => message.role !== 'system')
      .slice(0, parts.oldMessages.length)
    const lastRole = projectedOld[projectedOld.length - 1]?.role
    const prefix: ChatMessage[] = [
      ...(systemMessage ? [systemMessage] : []),
      ...projectedOld
    ]
    const priorState = this.context.compactionState?.state?.text
    const previousFacts = this.context.compactionState?.state?.handoff?.facts ?? []
    const archive = this.context.sessionStore && this.context.sessionId ? this.context.sessionStore.load(this.context.sessionId) : null
    const sourceMessages = parts.oldMessages.map(message => {
      const raw = message.role === 'user' ? archive?.messages.find(raw => raw.id === message.origin?.messageId) : undefined
      return raw ? { ...message, content: extractTextFromSerializableContent(raw.content) } : message
    })
    const required = collectRequiredFacts(sourceMessages, previousFacts)
    const instruction = [buildStateInstruction(priorState),
      'facts 中每项含 id/category/owner/value/origin{messageId,step}/quote/required。以下必需事实逐字段保留，不得改写、改归属或删除。额外事实只能引用原始 user 原句，owner 为该 messageId，value=quote。',
      JSON.stringify(required)].join('\n')
    const stubContext = [
      ...prefix,
      ...buildCompactionRequestTail(lastRole, buildStubPrompt())
    ]
    const stateContext = [
      ...prefix,
      ...buildCompactionRequestTail(
        lastRole,
        instruction
      )
    ]

    const [stubText, rawState] = await Promise.all([
      this.streamCompactionText(stubContext, 'compaction-stub', usageSources, abortSignal),
      this.streamCompactionText(stateContext, 'compaction-state', usageSources, abortSignal)
    ])
    if (abortSignal?.aborted) return null
    if (!rawState) {
      recordMetric('compaction.rejected', {}, { tags: { reason: 'missing-state-text' } })
      return null
    }

    const stateBudget = getStateTokenBudget(this.contextWindow)
    let candidate = rawState
    let handoff = validateHandoff(candidate, sourceMessages, required, previousFacts)
    if (!handoff || estimateTokens(renderStructuredHandoff(handoff)) > stateBudget) {
      const tightened = await this.streamCompactionText(
        [
          ...prefix,
          ...buildCompactionRequestTail(
            lastRole,
            [
              instruction,
              '修正并收紧以下原始候选，保留全部必需事实和五项内容。只输出完整 JSON；不得截断字段。',
              '',
              rawState
            ].join('\n')
          )
        ],
        'compaction-tighten',
        usageSources,
        abortSignal
      )
      if (abortSignal?.aborted) return null
      if (!tightened) return null
      candidate = tightened
      handoff = validateHandoff(candidate, sourceMessages, required, previousFacts)
    }
    if (!handoff) {
      recordMetric('compaction.rejected', { requiredFacts: required.length }, { tags: { reason: 'invalid-handoff' } })
      return null
    }
    const state = renderStructuredHandoff(handoff)
    if (estimateTokens(state) > stateBudget) {
      recordMetric('compaction.rejected', { stateBudget, requiredFacts: required.length }, { tags: { reason: 'state-budget' } })
      return null
    }

    return {
      stub: stubText,
      state,
      handoff
    }
  }

  private async streamCompactionText(
    messages: ChatMessage[],
    purpose: ChatRequestPurpose,
    usageSources: UsageSource[],
    abortSignal?: AbortSignal
  ): Promise<string | null> {
    const chatOptions: ChatOptions = {
      abortSignal,
      includeInternalMessages: true,
      purpose,
      observation: { logicalRequestId: randomUUID(), runId: this.context.runId, sessionId: this.context.sessionId },
      ...(this.promptCacheKey ? { promptCacheKey: this.promptCacheKey } : {})
    }

    let text = ''
    let source: UsageSource | undefined
    let acceptedText = false
    try {
      const stream = this.modelClient.chat(messages, undefined, chatOptions)
      for await (const event of stream) {
        if (abortSignal?.aborted) return null
        if (event.type === 'text_delta') {
          text += event.delta
        } else if (event.type === 'wire_snapshot') {
          source = event.source
          this.cacheDiagnostics.recordWireSnapshot(event.snapshot, {
            purpose
          })
        } else if (event.type === 'usage' && event.source) {
          source = event.source
        } else if (
          event.type === 'context_overflow'
          || event.type === 'error'
          || event.type === 'cancelled'
        ) {
          return null
        }
      }
      const trimmed = text.trim()
      acceptedText = trimmed.length > 0
      if (acceptedText && source) usageSources.push(source)
      return trimmed.length > 0 ? trimmed : null
    } catch {
      return null
    } finally {
      if (!acceptedText && source) metricUsageAdoption(source, false, 'compaction-context')
    }
  }

  /**
   * 采纳 stub/state 并重建上下文。
   * 膨胀保护：交接包 + 尾部必须严格小于压缩前投影总量，否则 fail-open。
   */
  private async applyCompactionResult(
    parts: CompactionParts,
    outputs: CompactionOutputs,
    projection: SummaryProjection,
    trigger: LedgerTrigger,
    canApply: () => boolean = () => true
  ): Promise<boolean> {
    const eligible = (): boolean => {
      const authority = parts.authority
      const current = this.measureRequest(this.context.messages, getEffectiveToolDefinitions(this.context))
      return !this.disposed && (trigger === 'idle' || this.canWrite()) && canApply() && Boolean(authority && authority.revision === (this.context.compactionState?.revision ?? 0) &&
        authority.routeId === current.routeId && authority.envelopeHash === current.envelopeHash && authority.messages === JSON.stringify(this.context.messages))
    }
    if (!eligible()) return false

    const tail = parts.recentMessages
    const beforeProjected = await projection.project(this.context.messages)
    const beforeTokens = estimateContextTokens(beforeProjected)

    const ledger = this.buildNextLedger(parts, outputs, trigger)
    const systemPrompt = this.getSystemPrompt?.(ledger.entries.length) ?? this.context.systemPrompt
    const rebuilt = rebuildWithCompression(systemPrompt, ledger, tail)
    const projected = await projection.project(rebuilt)
    if (!eligible()) return false
    const afterTokens = estimateContextTokens(projected)
    if (afterTokens >= beforeTokens) return false

    const budget = this.contextBudgetManager.enforceInline(projected)
    if (budget.status === 'requires_compaction') {
      throw new ContextBudgetExceededError(budget.estimatedTokens, budget.serializedBytes, true)
    }
    if (this.context.sessionStore && this.context.sessionId) {
      if (!this.context.sessionStore.commitCompaction(this.context.sessionId, ledger, parts.authority!.revision, this.context.messages, this.historyProjection)) {
        recordMetric('compaction.rejected', { revision: ledger.revision ?? 0 }, { tags: { reason: 'durable-frontier-or-revision' } })
        return false
      }
    }
    this.context.systemPrompt = systemPrompt
    this.context.messages = rebuilt
    this.context.compactionState = ledger
    this.context.compactionLevel = ledger.entries.length
    this.context.userTurnsSinceCompaction = 0
    this.updateTokenEstimate()
    this.cacheDiagnostics.bumpEpoch('compaction')
    recordMetric('compaction.committed', { revision: ledger.revision ?? 0, facts: outputs.handoff.facts.length }, { tags: {
      routeId: parts.authority!.routeId, envelopeHash: parts.authority!.envelopeHash, trigger,
      durability: this.context.sessionStore ? 'persisted' : 'ephemeral' } })
    return true
  }

  private buildNextLedger(
    parts: CompactionParts,
    outputs: CompactionOutputs,
    trigger: LedgerTrigger
  ): CompactionLedger {
    const tail = parts.recentMessages
    const firstOld = parts.oldMessages[0]
    const lastOld = parts.oldMessages[parts.oldMessages.length - 1]
    const firstTail = tail[0]
    const prev = this.context.compactionState
    const id = `c${(prev?.entries.length ?? 0) + 1}`
    const from = firstOld?.origin ?? { messageId: '', step: 0 }
    const to = lastOld?.origin ?? { messageId: '', step: 0 }
    const pointer = formatPointerStub(id, from, to)
    const stub = outputs.stub
      ? boundSummaryText(outputs.stub, MAX_STUB_ESTIMATED_TOKENS)
      : pointer
    const messageIds = [...new Set(
      parts.oldMessages
        .map(message => message.origin?.messageId)
        .filter((value): value is string => Boolean(value))
    )]
    const entry: LedgerEntry = {
      id,
      shadows: { from, to },
      stub: stub.includes(id) ? stub : `${stub}\n${pointer}`,
      touchedFiles: this.collectTouchedFiles?.(messageIds) ?? { paths: [], omittedCount: 0 },
      trigger,
      createdAt: Date.now()
    }
    const maxStubTokens = Math.floor(this.contextWindow * LEDGER_RENDER_WINDOW_RATIO)
    const entries = foldLedgerEntriesToBudget(
      [...(prev?.entries ?? []), entry],
      maxStubTokens
    )
    const anchors = this.getRealityAnchors?.()
    return {
      version: CONTEXT_SNAPSHOT_VERSION,
      revision: (prev?.revision ?? 0) + 1,
      entries,
      state: {
        validation: 'verified',
        handoff: outputs.handoff,
        text: outputs.state,
        coversThrough: to,
        taskVerbatim: this.resolveTaskVerbatim(parts, prev?.state?.taskVerbatim ?? null),
        realityLine: buildRealityLine(anchors?.workspacePath, anchors?.activePlanPath),
        revision: (prev?.state?.revision ?? 0) + 1
      },
      tailFrom: parts.cutAt ?? firstTail?.origin ?? null,
      updatedAt: Date.now()
    }
  }

  private resolveTaskVerbatim(
    parts: CompactionParts,
    previous: StateDoc['taskVerbatim']
  ): StateDoc['taskVerbatim'] {
    const current = [...this.context.messages]
      .reverse()
      .find(message => message.role === 'user' && !message.internal)
    if (!current) return previous
    const folded = parts.oldMessages.some(message =>
      message === current
      || (
        Boolean(message.origin)
        && Boolean(current.origin)
        && message.origin!.messageId === current.origin!.messageId
        && message.origin!.step === current.origin!.step
      )
    )
    if (!folded || !current.origin) return null
    const text = extractTextFromContent(current.content)
    const maxChars = 1_200
    return {
      text: text.length > maxChars ? `${text.slice(0, maxChars)}…` : text,
      origin: current.origin
    }
  }

  private notifyCompaction(trigger: LedgerTrigger): void {
    const ledger = this.context.compactionState
    if (!ledger) return
    this.onCompaction?.(this.context.messages, {
      summary: ledger.state?.text ?? '',
      compactionLevel: ledger.entries.length,
      trigger,
      ledger
    })
  }

  setHistoryProjection(options: BuildConversationContextOptions): void {
    this.historyProjection = { ...options, from: undefined }
  }
}

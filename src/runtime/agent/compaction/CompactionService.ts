import type { ModelClient, ChatOptions } from '../../model/ModelClient'
import type { ChatMessage, MessageOrigin } from '../../model/types'
import { extractTextFromContent } from '../../model/types'
import type { CacheDiagnostics } from '../../model/cacheDiagnostics'
import type { CacheProfile } from '../../model/cacheProfile'
import type { ContextBudgetManager } from '../ContextBudgetManager'
import { ContextBudgetExceededError, resolveProductionBudgetLimits } from '../ContextBudgetManager'
import type { AgentContext } from '../core/AgentContext'
import { formatPointerStub } from '../core/renderHandoffPacket'
import type { SummaryProjection } from '../../request-projection'
import type { CompactionMeta } from '../types'
import {
  CONTEXT_SNAPSHOT_VERSION,
  type CompactionLedger,
  type LedgerEntry,
  type LedgerTrigger,
  type StateDoc,
  type TouchedFilesSnapshot
} from '../../sessions'
import { CHARS_PER_TOKEN, estimateContextTokens, estimateTokens } from '../tokenEstimator'
import { IdleCompressionTimer } from './IdleCompressionTimer'
import {
  estimateNextRequestTokens,
  measureRequestPayloadChars
} from './estimateNextRequestTokens'
import {
  MAX_STUB_ESTIMATED_TOKENS,
  LEDGER_RENDER_WINDOW_RATIO,
  boundSummaryText,
  buildCompactionRequestTail,
  buildRealityLine,
  buildStubPrompt,
  buildStateInstruction,
  foldLedgerEntriesToBudget,
  getCompactionThreshold,
  getStateTokenBudget,
  getTailTokenBudget,
  rebuildWithCompression,
  shouldScheduleIdleCompaction,
  shouldCompact,
  splitForCompactionByTokens,
  truncateStateFromEnd
} from './compaction'

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
  /** 按被折叠 messageId 聚合 checkpoint 文件清单；缺省视为无变更 */
  collectTouchedFiles?: (messageIds: readonly string[]) => TouchedFilesSnapshot
  /** 提交瞬间的工作区 / activePlan 路径 */
  getRealityAnchors?: () => { workspacePath: string | null; activePlanPath: string | null }
}

interface CompactionParts {
  oldMessages: ChatMessage[]
  recentMessages: ChatMessage[]
  cutAt: MessageOrigin | null
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
  private readonly collectTouchedFiles: CompactionServiceOptions['collectTouchedFiles']
  private readonly getRealityAnchors?: () => { workspacePath: string | null; activePlanPath: string | null }
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

  /**
   * 记录刚发出的请求锚点：provider 真实 input usage + 当时 payload 字符量。
   * 仅在见到正数 usage 时更新；供下一步 mid-turn 估算使用。
   */
  recordRequestAnchor(inputTokens: number, payloadChars: number): void {
    if (!Number.isFinite(inputTokens) || inputTokens <= 0) return
    this.lastRequestInputTokens = Math.floor(inputTokens)
    this.lastRequestPayloadChars = Math.max(0, Math.floor(payloadChars))
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

    try {
      const outputs = await this.requestCompactionOutputs(parts, projection, abortSignal)
      if (!outputs || abortSignal?.aborted) return false

      if (!await this.applyCompactionResult(
        parts,
        outputs,
        projection,
        'mid-turn',
        () => !abortSignal?.aborted && !this.disposed
      )) return false
      if (abortSignal?.aborted) return false
      this.notifyCompaction('mid-turn')
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
      const extraTailTokens = mode === 'aggressive' ? getTailTokenBudget(this.contextWindow) : 0
      const parts = this.splitOverflowContext(extraTailTokens)
      if (parts.oldMessages.length === 0) return false

      const outputs = await this.requestCompactionOutputs(parts, projection, abortSignal)
      if (!outputs || abortSignal?.aborted) return false

      if (!await this.applyCompactionResult(
        parts,
        outputs,
        projection,
        'overflow',
        () => !abortSignal?.aborted && !this.disposed
      )) return false
      if (abortSignal?.aborted) return false
      this.notifyCompaction('overflow')
      return true
    } catch {
      return false
    } finally {
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

    const outputs = await this.requestCompactionOutputs(parts, projection, abortSignal)
    if (!outputs || abortSignal?.aborted || !canApply()) return false

    if (!await this.applyCompactionResult(
      parts,
      outputs,
      projection,
      trigger,
      () => !abortSignal?.aborted && !this.disposed && canApply()
    )) return false
    if (abortSignal?.aborted || !canApply()) return false
    this.notifyCompaction(trigger)
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
    abortSignal?: AbortSignal
  ): Promise<{ stub: string | null; state: string } | null> {
    if (abortSignal?.aborted) return null

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
    const stubContext = [
      ...prefix,
      ...buildCompactionRequestTail(lastRole, buildStubPrompt())
    ]
    const stateContext = [
      ...prefix,
      ...buildCompactionRequestTail(
        lastRole,
        buildStateInstruction(priorState)
      )
    ]

    const [stubText, rawState] = await Promise.all([
      this.streamCompactionText(stubContext, abortSignal),
      this.streamCompactionText(stateContext, abortSignal)
    ])
    if (abortSignal?.aborted) return null
    if (!rawState) return null

    const stateBudget = getStateTokenBudget(this.contextWindow)
    let state = boundSummaryText(rawState, stateBudget)
    if (estimateTokens(state) > stateBudget) {
      const tightened = await this.streamCompactionText(
        [
          ...prefix,
          ...buildCompactionRequestTail(
            lastRole,
            [
              '请把下面这份状态文档收紧。保留「目标」和「下一步」，可以大幅压缩「关键决策」。只输出收紧后的五段摘要。',
              '',
              state
            ].join('\n')
          )
        ],
        abortSignal
      )
      if (abortSignal?.aborted) return null
      if (tightened) state = tightened
    }
    state = truncateStateFromEnd(state, stateBudget)

    return {
      stub: stubText,
      state
    }
  }

  private async streamCompactionText(
    messages: ChatMessage[],
    abortSignal?: AbortSignal
  ): Promise<string | null> {
    const chatOptions: ChatOptions = {
      abortSignal,
      includeInternalMessages: true,
      purpose: 'compaction-summary',
      ...(this.promptCacheKey ? { promptCacheKey: this.promptCacheKey } : {})
    }

    let text = ''
    try {
      const stream = this.modelClient.chat(messages, undefined, chatOptions)
      for await (const event of stream) {
        if (abortSignal?.aborted) return null
        if (event.type === 'text_delta') {
          text += event.delta
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

    const trimmed = text.trim()
    return trimmed.length > 0 ? trimmed : null
  }

  /**
   * 采纳 stub/state 并重建上下文。
   * 膨胀保护：交接包 + 尾部必须严格小于压缩前投影总量，否则 fail-open。
   */
  private async applyCompactionResult(
    parts: CompactionParts,
    outputs: { stub: string | null; state: string },
    projection: SummaryProjection,
    trigger: LedgerTrigger,
    canApply: () => boolean = () => true
  ): Promise<boolean> {
    if (!canApply()) return false

    const tail = parts.recentMessages
    const beforeProjected = await projection.project(this.context.messages)
    const beforeTokens = estimateContextTokens(beforeProjected)

    const ledger = this.buildNextLedger(parts, outputs, trigger)
    const rebuilt = rebuildWithCompression(this.context.systemPrompt, ledger, tail)
    const projected = await projection.project(rebuilt)
    if (!canApply()) return false
    const afterTokens = estimateContextTokens(projected)
    if (afterTokens >= beforeTokens) return false

    const budget = this.contextBudgetManager.enforceInline(projected)
    if (budget.status === 'requires_compaction') {
      throw new ContextBudgetExceededError(budget.estimatedTokens, budget.serializedBytes, true)
    }
    this.context.messages = rebuilt
    this.context.compactionState = ledger
    this.context.compactionLevel = ledger.entries.length
    this.context.userTurnsSinceCompaction = 0
    this.updateTokenEstimate()
    this.cacheDiagnostics.bumpEpoch('compaction')
    return true
  }

  private buildNextLedger(
    parts: CompactionParts,
    outputs: { stub: string | null; state: string },
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
      entries,
      state: {
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
}

/**
 * AttemptController — 统一 retry / fallback 的 attempt 所有权
 *
 * 本控制器：
 * - 明确定义 maxAttempts =「当前 provider 的恢复尝试次数」（含首次错误）
 * - 每次模型流开始时分配唯一 attemptId；只有模型错误进入恢复链时才消耗预算
 * - 失败后按结构化 failure + hasNoObservableOutput 门闩决定：再试 / 切 fallback / 上下文恢复 / 终止
 * - fallback 切换后为新 provider 建独立计数，保留全 run 总预算
 *
 * 安全重试门闩：只有当本次 attempt 未产生任何可观察输出（无 tool call /
 * 无正文 / 无 reasoning）时才允许重试。已产生权威输出的失败不得重试，
 * 否则会导致副作用重复执行（如迁移跑两遍）或半个有效答案被丢弃。
 *
 * 例外：「费用不确定」失败（响应头后断流）可重放——工具在整段流结束后才执行，
 * 模型请求本身无本地副作用；半截输出由 StreamProcessor 清空后重跑。
 *
 * 禁止：只把 `<` 改成 `<=`（两状态机仍争 attempt 语义）。
 */
import { randomUUID } from 'crypto'
import { decideFallback } from './FallbackDecider'
import {
  MAX_RETRY_ATTEMPTS,
  type RecoveryState,
  type RecoveryStateMachine
} from './RecoveryStateMachine'
import type { ModelClientPool } from '../../model/ModelClientPool'
import type { ModelFailure, ModelFailureKind } from '../../model/failureTypes'
import { REMOTE_RESULT_UNKNOWN_NOTICE } from '../../../shared/session/terminalErrorBlocks'

/** attempt 失败后的决策 */
export type AttemptDecision =
  | { action: 'retry'; attemptId: string; attempt: number; hint: string; backoffMs: number }
  | { action: 'fallback'; attemptId: string; nextFallbackIndex: number; reason: string; modelId: string; fallbackIndex: number }
  | { action: 'recover_context'; state: RecoveryState }
  | { action: 'fail'; error: string; kind: ModelFailureKind }

/** 「费用不确定」失败每个模型步骤的重放上限；按步骤计数，长任务每步都有独立额度 */
export const UNCERTAIN_DISPATCH_REPLAY_BUDGET = 2

export interface AttemptControllerOptions {
  recovery: RecoveryStateMachine
  modelPool: ModelClientPool
  /** 当前 provider 恢复尝试次数上限（含首次错误），默认 MAX_RETRY_ATTEMPTS */
  maxAttemptsPerProvider?: number
  /** 全 run 恢复尝试总预算（含所有 provider），默认按 provider 数量计算 */
  maxTotalAttempts?: number
  /**
   * 随机源注入点，便于测试断言确定性退避序列；生产用 Math.random。
   * 返回 [0,1) 区间的数，用于叠加 jitter。
   */
  random?: () => number
}

export class AttemptController {
  private readonly recovery: RecoveryStateMachine
  private readonly modelPool: ModelClientPool
  /** 当前 provider 已进入恢复链的错误 attempt 次数 */
  private providerAttempt = 0
  /** 全 run 已进入恢复链的错误 attempt 次数 */
  private totalAttempts = 0
  private readonly maxAttemptsPerProvider: number
  private readonly maxTotalAttempts: number
  /** 当前进行中的 attemptId（beginAttempt 写入） */
  private currentAttemptId: string | null = null
  /** 当前模型步骤标识；变化时重置步骤级预算（retry 属于同一步骤） */
  private currentStepId: string | null = null
  /** 当前步骤内已发生的「费用不确定」重放次数 */
  private uncertainDispatchReplays = 0
  private readonly random: () => number

  constructor(opts: AttemptControllerOptions) {
    this.recovery = opts.recovery
    this.modelPool = opts.modelPool
    this.maxAttemptsPerProvider = opts.maxAttemptsPerProvider ?? MAX_RETRY_ATTEMPTS
    const fallbackCount = this.modelPool.getFallbackCount()
    this.maxTotalAttempts =
      opts.maxTotalAttempts ??
      this.maxAttemptsPerProvider * (1 + Math.max(0, fallbackCount))
    this.random = opts.random ?? Math.random
  }

  /** 新消息开始时重置 */
  reset(): void {
    this.providerAttempt = 0
    this.totalAttempts = 0
    this.currentAttemptId = null
    this.currentStepId = null
    this.uncertainDispatchReplays = 0
  }

  /** 当前步骤内「费用不确定」失败还剩几次重放额度 */
  getUncertainDispatchReplayBudget(): number {
    return Math.max(0, UNCERTAIN_DISPATCH_REPLAY_BUDGET - this.uncertainDispatchReplays)
  }

  /** 当前 provider 恢复链已消耗的 attempt 数*/
  getProviderAttempt(): number {
    return this.providerAttempt
  }

  getTotalAttempts(): number {
    return this.totalAttempts
  }

  getCurrentAttemptId(): string | null {
    return this.currentAttemptId
  }

  /**
   * 每次模型调用开始前调用：分配唯一 attemptId。
   *
   * 正常工具续轮也是新的模型流，但不是错误恢复；因此不能在这里消耗恢复预算。
   *
   * @param stepId 所属模型步骤标识。retry 重跑沿用同一步骤 id（预算继续消耗）；
   *   步骤变化时重置步骤级重放预算。不传时预算在整轮内累计。
   */
  beginAttempt(stepId?: string): string {
    if (stepId !== undefined && stepId !== this.currentStepId) {
      this.currentStepId = stepId
      this.uncertainDispatchReplays = 0
    }
    this.currentAttemptId = `att_${randomUUID()}`
    return this.currentAttemptId
  }

  /**
   * 处理一次模型 error 事件，返回下一步动作。
   *
   * 安全重试门闩：重试仅在 failure.retryable 且 hasNoObservableOutput 时允许。
   * 已产生可观察输出的失败直接走 fallback 或终态失败，绝不重试。
   * 「费用不确定」失败例外：见 replayUncertainDispatch。
   *
   * @param error 错误文本（可含 ModelTransport 分类前缀）
   * @param failure 结构化失败；存在时为决策真源
   * @param hasNoObservableOutput 本次 attempt 是否未产生任何权威输出
   */
  onError(
    error: string,
    failure?: ModelFailure,
    hasNoObservableOutput = false
  ): AttemptDecision {
    if (failure?.dispatchOutcome === 'unknown') return this.replayUncertainDispatch(failure)
    if (!hasNoObservableOutput) return { action: 'fail', error, kind: failure?.kind ?? 'unknown' }
    // classify 的 attempt 参数语义：当前错误前已消耗的恢复次数（从 0 起）。
    const completedBeforeThis = this.providerAttempt
    const errState = this.recovery.classify(error, completedBeforeThis, failure)
    this.providerAttempt += 1
    this.totalAttempts += 1

    if (this.totalAttempts > this.maxTotalAttempts) {
      return { action: 'fail', error: `已达全 run attempt 预算上限（${this.totalAttempts}）`, kind: failure?.kind ?? 'unknown' }
    }

    if (errState.kind === 'recovering') {
      return { action: 'recover_context', state: errState }
    }

    // 重试门闩：retryable + 未超限 + 本次 attempt 无可观察输出。
    // 任何已产生权威事实的失败都不重试——直接走 fallback 或终态失败。
    const failureRetryable = failure ? failure.retryable : errState.kind === 'retrying'
    const mayRetry =
      failureRetryable &&
      hasNoObservableOutput &&
      errState.kind === 'retrying' &&
      this.recovery.shouldRetry(errState)

    if (mayRetry) {
      const hint = this.recovery.buildRecoveryHint(errState)
      return {
        action: 'retry',
        attemptId: this.currentAttemptId ?? '',
        attempt: errState.attempt,
        hint,
        backoffMs: this.computeBackoffMs(errState.attempt, failure)
      }
    }

    // 重试耗尽（或非 retrying / 已有可观察输出）：用「已消耗次数」驱动 fallback。
    // providerAttempt 在本次错误进入恢复链时已递增，故耗尽时 === maxAttemptsPerProvider。
    const fallbackDecision = decideFallback({
      currentError: error,
      retryAttempt: this.providerAttempt,
      maxAttempts: this.maxAttemptsPerProvider,
      currentFallbackIndex: this.modelPool.getActiveFallbackIndex(),
      availableFallbackCount: this.modelPool.getFallbackCount()
    })

    if (fallbackDecision.shouldFallback && fallbackDecision.nextFallbackIndex !== undefined) {
      const nextIndex = fallbackDecision.nextFallbackIndex
      this.modelPool.switchToFallback(nextIndex)
      // 新 provider 独立计数；全 run 总预算保留
      this.providerAttempt = 0
      const provider = this.modelPool.getActiveProvider()
      return {
        action: 'fallback',
        attemptId: this.currentAttemptId ?? '',
        nextFallbackIndex: nextIndex,
        reason: fallbackDecision.reason,
        modelId: provider.modelId,
        fallbackIndex: provider.fallbackIndex
      }
    }

    const failError =
      errState.kind === 'failed' ? errState.error : error
    return { action: 'fail', error: failError, kind: failure?.kind ?? 'unknown' }
  }

  /** 费用不确定的失败走独立小额预算：多计一次费的代价小于长任务整轮失败 */
  private replayUncertainDispatch(failure: ModelFailure): AttemptDecision {
    if (this.getUncertainDispatchReplayBudget() === 0) {
      // 终态文案只在预算耗尽处声明「已停止自动重试」，展示层据此不给重试按钮
      return { action: 'fail', error: `${failure.message}，${REMOTE_RESULT_UNKNOWN_NOTICE}`, kind: failure.kind }
    }
    this.uncertainDispatchReplays += 1
    const attempt = this.uncertainDispatchReplays
    return {
      action: 'retry',
      attemptId: this.currentAttemptId ?? '',
      attempt,
      hint: this.recovery.buildRecoveryHint(this.uncertainDispatchState(failure)),
      backoffMs: this.computeBackoffMs(attempt, failure)
    }
  }

  private uncertainDispatchState(failure: ModelFailure): RecoveryState {
    return {
      kind: 'retrying',
      attempt: this.uncertainDispatchReplays,
      lastError: failure.message,
      maxAttempts: UNCERTAIN_DISPATCH_REPLAY_BUDGET
    }
  }

  /**
   * 退避毫秒数：retryAfterMs 优先（provider 明示），否则指数退避叠加 jitter。
   */
  private computeBackoffMs(attempt: number, failure?: ModelFailure): number {
    if (failure?.retryAfterMs !== undefined) {
      return failure.retryAfterMs
    }
    const base = this.recovery.backoffMs(attempt)
    const jitter = Math.ceil(this.random() * this.recovery.jitterCeilMs(attempt))
    return base + jitter
  }

  /** 构造 recovery_state 事件用的状态（与 onError 分类一致，供 emit） */
  classifyForEmit(error: string, failure?: ModelFailure): RecoveryState {
    if (failure?.dispatchOutcome === 'unknown' && this.getUncertainDispatchReplayBudget() > 0) {
      // 与 replayUncertainDispatch 同一状态：预算内就是 retrying，UI 不闪 failed
      return {
        kind: 'retrying',
        attempt: this.uncertainDispatchReplays + 1,
        lastError: failure.message,
        maxAttempts: UNCERTAIN_DISPATCH_REPLAY_BUDGET
      }
    }
    const completedBeforeThis = this.providerAttempt
    return this.recovery.classify(error, completedBeforeThis, failure)
  }
}

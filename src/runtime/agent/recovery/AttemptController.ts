/**
 * AttemptController — 统一 retry / fallback 的 attempt 所有权
 
 * 本控制器：
 * - 明确定义 maxAttempts =「当前 provider 的恢复尝试次数」（含首次错误）
 * - 每次模型流开始时分配唯一 attemptId；只有模型错误进入恢复链时才消耗预算
 * - 失败后按错误分类决定：再试 / 切 fallback / 上下文恢复 / 终止
 * - fallback 切换后为新 provider 建独立计数，保留全 run 总预算
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

/** attempt 失败后的决策 */
export type AttemptDecision =
  | { action: 'retry'; attemptId: string; attempt: number; hint: string; backoffMs: number }
  | { action: 'fallback'; attemptId: string; nextFallbackIndex: number; reason: string; modelId: string; fallbackIndex: number }
  | { action: 'recover_context'; state: RecoveryState }
  | { action: 'fail'; error: string }

export interface AttemptControllerOptions {
  recovery: RecoveryStateMachine
  modelPool: ModelClientPool
  /** 当前 provider 恢复尝试次数上限（含首次错误），默认 MAX_RETRY_ATTEMPTS */
  maxAttemptsPerProvider?: number
  /** 全 run 恢复尝试总预算（含所有 provider），默认按 provider 数量计算 */
  maxTotalAttempts?: number
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

  constructor(opts: AttemptControllerOptions) {
    this.recovery = opts.recovery
    this.modelPool = opts.modelPool
    this.maxAttemptsPerProvider = opts.maxAttemptsPerProvider ?? MAX_RETRY_ATTEMPTS
    const fallbackCount = this.modelPool.getFallbackCount()
    this.maxTotalAttempts =
      opts.maxTotalAttempts ??
      this.maxAttemptsPerProvider * (1 + Math.max(0, fallbackCount))
  }

  /** 新消息开始时重置 */
  reset(): void {
    this.providerAttempt = 0
    this.totalAttempts = 0
    this.currentAttemptId = null
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
   */
  beginAttempt(): string {
    this.currentAttemptId = `att_${randomUUID()}`
    return this.currentAttemptId
  }

  /**
   * 处理一次模型 error 事件，返回下一步动作。
   *
   * 关键修复：用「已消耗的 providerAttempt」作为 decideFallback 的 retryAttempt，
   * 而不是只在 shouldRetry 分支才更新的陈旧计数。
   *
   * @param error 错误文本（可含 ModelTransport 分类前缀）
   */
  onError(error: string): AttemptDecision {
    // classify 的 attempt 参数语义：当前错误前已消耗的恢复次数（从 0 起）。
    const completedBeforeThis = this.providerAttempt
    const errState = this.recovery.classify(error, completedBeforeThis)
    this.providerAttempt += 1
    this.totalAttempts += 1

    if (this.totalAttempts > this.maxTotalAttempts) {
      return { action: 'fail', error: `已达全 run attempt 预算上限（${this.totalAttempts}）` }
    }

    if (errState.kind === 'recovering') {
      return { action: 'recover_context', state: errState }
    }

    // 当前 provider 仍可重试（attempt < max）
    if (errState.kind === 'retrying' && this.recovery.shouldRetry(errState)) {
      const hint = this.recovery.buildRecoveryHint(errState)
      return {
        action: 'retry',
        attemptId: this.currentAttemptId ?? '',
        attempt: errState.attempt,
        hint,
        backoffMs: this.recovery.backoffMs(errState.attempt)
      }
    }

    // 重试耗尽（或非 retrying）：用「已消耗次数」驱动 fallback。
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
    return { action: 'fail', error: failError }
  }

  /** 构造 recovery_state 事件用的状态（与 onError 分类一致，供 emit） */
  classifyForEmit(error: string): RecoveryState {
    const completedBeforeThis = this.providerAttempt
    return this.recovery.classify(error, completedBeforeThis)
  }
}

/**
 * 副作用上下文：由调用方显式传入，禁止靠全局 currentStep 推断。
 *
 * effects/ 是依赖图最底层，不得 import workflow 下任何其他模块，
 * 因此副作用策略类型在此定义，由上层复用而非反向依赖。
 */

/** 副作用的重试 / 幂等策略 */
export interface SideEffectPolicy {
  /** 失败是否可重试（resume 时重新执行） */
  retryable?: boolean
  /** 副作用类型：影响 resume 是否安全重跑 */
  sideEffect?: 'none' | 'llm' | 'bash' | 'worktree' | 'integrate' | 'fs' | 'state'
  /**
   * bash 专用：命令是否幂等（默认 false）。
   * 仅只读命令（rev-parse/status/log）可标 true；commit/push/install 永远 false。
   * 非幂等 + 中断恢复且无成功 receipt → blocked，禁止自动重跑。
   */
  idempotent?: boolean
}

/**
 * 副作用提交所需的最小上下文。
 * 字段与上层 step 上下文结构兼容，因此可直接传入而无需转换。
 */
export interface SideEffectCtx {
  runId: string
  stepId: string
  inputHash: string
  idempotencyKey: string
  policy?: SideEffectPolicy
  /** 从上次 status=running 崩溃恢复时为 true */
  resumingInterrupted?: boolean
}

/** 非幂等副作用在中断恢复时禁止自动重放 */
export class SideEffectBlockedError extends Error {
  readonly code = 'SIDE_EFFECT_BLOCKED' as const
  constructor(message: string) {
    super(message)
    this.name = 'SideEffectBlockedError'
  }
}

export function isSideEffectCtx(v: unknown): v is SideEffectCtx {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return typeof o.idempotencyKey === 'string' && o.idempotencyKey.length > 0
}

/** 将 idempotencyKey 转为可作文件名的 effectId */
export function effectIdFromKey(idempotencyKey: string): string {
  return idempotencyKey.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
}

/**
 * 测试用故障注入点（生产默认 no-op）。
 * 崩溃矩阵测试通过 setFaultInjector 注入 throw。
 */
export type FaultPoint =
  | 'before-execute'
  | 'after-prepared'
  | 'after-execute'
  | 'after-receipt'
  | 'before-step-commit'

type FaultInjector = (stepId: string, point: FaultPoint) => void

let faultInjector: FaultInjector | null = null

export function setFaultInjector(fn: FaultInjector | null): void {
  faultInjector = fn
}

export function injectFault(stepId: string | undefined, point: FaultPoint): void {
  if (!faultInjector || !stepId) return
  faultInjector(stepId, point)
}

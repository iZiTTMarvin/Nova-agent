/**
 * 副作用上下文：从 StepRunContext 显式传入 hook，禁止靠全局 currentStep 推断。
 */
import type { StepPolicy, StepRunContext } from './types'

/** hook 侧需要的最小 step 上下文（可从 StepRunContext 直接传入） */
export type SideEffectCtx = Pick<
  StepRunContext,
  'runId' | 'stepId' | 'idempotencyKey' | 'inputHash'
> & {
  policy?: StepPolicy
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

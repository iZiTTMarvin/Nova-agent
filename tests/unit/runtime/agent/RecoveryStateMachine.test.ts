import { describe, it, expect } from 'vitest'
import { RecoveryStateMachine } from '../../../../src/runtime/agent/recovery/RecoveryStateMachine'

describe('RecoveryStateMachine', () => {
  const rsm = new RecoveryStateMachine()

  it('未知错误进入 failed', () => {
    expect(rsm.classify('something weird', 0).kind).toBe('failed')
  })

  it('rate limit 进入 retrying', () => {
    const s = rsm.classify('rate limit exceeded', 0)
    expect(s.kind).toBe('retrying')
    if (s.kind === 'retrying') expect(s.attempt).toBe(1)
  })

  it('context overflow 进入 recovering', () => {
    expect(rsm.classify('context overflow detected', 0).kind).toBe('recovering')
  })

  it('熔断错误进入 failed', () => {
    expect(rsm.classify('[已自动中断] 连续失败', 0).kind).toBe('failed')
  })

  it('shouldRetry 在 retrying 且未超限时为 true', () => {
    const s = rsm.classify('timeout', 0)
    expect(rsm.shouldRetry(s)).toBe(true)
  })

  it('超过 maxAttempts 进入 failed（上限 10）', () => {
    // maxAttempts 已从 3 提到 10（阶段四安全重试，对齐 maka）
    expect(rsm.classify('timeout', 10).kind).toBe('failed')
    // 未达上限仍可重试
    expect(rsm.classify('timeout', 9).kind).toBe('retrying')
  })

  it('retrying 状态 buildRecoveryHint 含尝试次数', () => {
    const s = rsm.classify('network error', 1)
    const hint = rsm.buildRecoveryHint(s)
    expect(hint).toContain('重试')
  })

  it('recovering 状态 hint 提及压缩', () => {
    const s = rsm.classify('token limit', 0)
    expect(rsm.buildRecoveryHint(s)).toContain('压缩')
  })

  it('continuing 返回空 hint', () => {
    expect(rsm.buildRecoveryHint({ kind: 'continuing' })).toBe('')
  })

  it('backoffMs 指数增长有上限（对齐 maka：base 1s，max 32s）', () => {
    expect(rsm.backoffMs(1)).toBe(1000)
    expect(rsm.backoffMs(3)).toBe(4000)
    expect(rsm.backoffMs(5)).toBe(16000)
    expect(rsm.backoffMs(6)).toBe(32000)
    // 触顶后不再增长
    expect(rsm.backoffMs(10)).toBe(32000)
  })

  it('5xx 错误触发 retrying', () => {
    expect(rsm.classify('HTTP 503', 0).kind).toBe('retrying')
  })
})

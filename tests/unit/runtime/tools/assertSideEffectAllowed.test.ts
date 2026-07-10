/**
 * 副作用入口 fencing：abort + execution generation
 */
import { describe, it, expect } from 'vitest'
import { assertSideEffectAllowed, type ToolContext } from '../../../../src/runtime/tools/types'
import { createReadState } from '../../../../src/runtime/tools/editTool'

function baseCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: '/tmp',
    readState: createReadState(),
    ...overrides
  }
}

describe('assertSideEffectAllowed', () => {
  it('无 fence 且未 abort 时放行', () => {
    expect(() => assertSideEffectAllowed(baseCtx())).not.toThrow()
  })

  it('abortSignal 已触发时拒绝', () => {
    const ac = new AbortController()
    ac.abort()
    expect(() => assertSideEffectAllowed(baseCtx({ abortSignal: ac.signal }), 'write')).toThrow(
      /write已取消/
    )
  })

  it('assertExecutionCurrent 返回 false 时拒绝', () => {
    expect(() =>
      assertSideEffectAllowed(baseCtx({ assertExecutionCurrent: () => false }), 'checkpoint')
    ).toThrow(/generation 已失效/)
  })

  it('assertExecutionCurrent 返回 true 时放行', () => {
    expect(() =>
      assertSideEffectAllowed(baseCtx({ assertExecutionCurrent: () => true }))
    ).not.toThrow()
  })
})

import { describe, it, expect } from 'vitest'
import { buildL1MemoryContext } from '../../../../src/runtime/memory/MemoryInjector'
import { applyL1Budget } from '../../../../src/runtime/memory/MemoryBudget'

describe('MemoryInjector.buildL1MemoryContext', () => {
  it('空精华返回 null', () => {
    expect(buildL1MemoryContext('')).toBeNull()
    expect(buildL1MemoryContext('   ')).toBeNull()
  })

  it('有内容时返回预算内文本', () => {
    const essence = '# 偏好\n注释用中文。'
    expect(buildL1MemoryContext(essence)).toBe(essence)
  })

  it('超长时应用 L1 预算', () => {
    const long = 'x'.repeat(5000)
    const out = buildL1MemoryContext(long)
    expect(out).not.toBeNull()
    expect(out!.length).toBeLessThanOrEqual(applyL1Budget(long).length)
  })
})

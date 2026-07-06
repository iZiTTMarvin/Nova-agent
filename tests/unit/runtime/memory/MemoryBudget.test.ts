import { describe, it, expect } from 'vitest'
import {
  applyL1Budget,
  applyL2Budget,
  DEFAULT_L1_MAX_CHARS,
  DEFAULT_L2_MAX_CHARS,
  L2_HIT_SEPARATOR
} from '../../../../src/runtime/memory/MemoryBudget'

describe('MemoryBudget', () => {
  it('applyL1Budget 未超限返回原文', () => {
    const text = '短文本'
    expect(applyL1Budget(text)).toBe(text)
  })

  it('applyL1Budget 超限时按行边界裁剪', () => {
    const lines = ['# 标题', 'a'.repeat(100), 'b'.repeat(100)]
    const text = lines.join('\n')
    const out = applyL1Budget(text, 50)
    expect(out.length).toBeLessThanOrEqual(50)
    expect(out).toBe('# 标题')
  })

  it('applyL1Budget 首行即超长时硬切兜底', () => {
    const text = 'x'.repeat(DEFAULT_L1_MAX_CHARS + 50)
    const out = applyL1Budget(text)
    expect(out.length).toBe(DEFAULT_L1_MAX_CHARS)
  })

  it('applyL2Budget 未超限返回原文', () => {
    const text = '=== Relevant Memory ===\n片段'
    expect(applyL2Budget(text)).toBe(text)
  })

  it('applyL2Budget 超限时在命中块分隔处截断', () => {
    const block = [
      '=== Relevant Memory ===',
      '[a.md]',
      'a'.repeat(200),
      `${L2_HIT_SEPARATOR}[b.md]`,
      'b'.repeat(DEFAULT_L2_MAX_CHARS)
    ].join('\n')
    const out = applyL2Budget(block, 300)
    expect(out.length).toBeLessThanOrEqual(300)
    expect(out).toContain('[a.md]')
    expect(out).not.toContain('[b.md]')
  })
})

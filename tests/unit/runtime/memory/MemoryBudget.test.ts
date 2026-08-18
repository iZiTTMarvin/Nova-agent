import { describe, it, expect } from 'vitest'
import {
  MEMORY_PREFETCH_DOCUMENT_MAX_ITEMS,
  MEMORY_PREFETCH_GLOBAL_MAX_ITEMS,
  MEMORY_PREFETCH_PROJECT_STRUCTURED_MAX_ITEMS,
  MEMORY_PREFETCH_SCORE_FLOOR,
  MEMORY_PREFETCH_STRUCTURED_MAX_CHARS,
  MEMORY_PREFETCH_TOTAL_MAX_CHARS,
  MEMORY_SNIPPET_MAX_CHARS
} from '../../../../src/runtime/memory/MemoryBudget'

describe('MemoryBudget', () => {
  it('prefetch 预算常量与注入契约一致', () => {
    expect(MEMORY_PREFETCH_TOTAL_MAX_CHARS).toBe(2400)
    expect(MEMORY_PREFETCH_STRUCTURED_MAX_CHARS).toBe(320)
    expect(MEMORY_PREFETCH_PROJECT_STRUCTURED_MAX_ITEMS).toBe(4)
    expect(MEMORY_PREFETCH_GLOBAL_MAX_ITEMS).toBe(2)
    expect(MEMORY_PREFETCH_DOCUMENT_MAX_ITEMS).toBe(2)
    expect(MEMORY_PREFETCH_SCORE_FLOOR).toBeGreaterThan(0)
    expect(MEMORY_PREFETCH_SCORE_FLOOR).toBeLessThan(1)
  })

  it('文档片段字符上限为正', () => {
    expect(MEMORY_SNIPPET_MAX_CHARS).toBeGreaterThan(0)
  })
})

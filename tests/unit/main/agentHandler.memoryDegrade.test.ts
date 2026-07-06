/**
 * 记忆检索降级：L2 自动注入已移除，检索改由 memory_search 工具承担
 */
import { describe, it, expect } from 'vitest'
import { getToolCapability } from '../../../src/shared/session/toolVisibility'

describe('记忆检索路径（L2 自动注入已停用）', () => {
  it('memory_search 为 readonly，plan 模式可见可用', () => {
    expect(getToolCapability('memory_search')).toBe('readonly')
  })
})

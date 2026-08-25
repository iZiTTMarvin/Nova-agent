/**
 * 记忆检索降级：L2 自动注入已移除，检索改由 memory_search 工具承担
 */
import { describe, it, expect } from 'vitest'
import { isToolVisibleInMode } from '../../../src/shared/session/toolVisibility'
import { getToolPermissionDescriptor } from '../../../src/shared/permissions/toolEffects'

describe('记忆检索路径（L2 自动注入已停用）', () => {
  it('memory_search 可在 plan 下使用，且不按写文件处理', () => {
    expect(isToolVisibleInMode('plan', 'memory_search')).toBe(true)
    expect(getToolPermissionDescriptor('memory_search')?.effects).toEqual(['filesystem.read'])
  })
})

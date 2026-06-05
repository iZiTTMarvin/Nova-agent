/**
 * toolVisibility 单元测试
 *
 * 重点验证：todo_write 被显式归类为 readonly，plan 模式下可见且不被当作 write/bash 隐藏。
 */
import { describe, expect, it } from 'vitest'
import { getToolCapability, isToolVisibleInMode, isModeHiddenWriteTool } from '../../../src/shared/session/toolVisibility'

describe('toolVisibility', () => {
  describe('getToolCapability', () => {
    it('读类工具归为 readonly', () => {
      expect(getToolCapability('ls')).toBe('readonly')
      expect(getToolCapability('read')).toBe('readonly')
      expect(getToolCapability('grep')).toBe('readonly')
      expect(getToolCapability('find')).toBe('readonly')
    })

    it('写类工具归为 write', () => {
      expect(getToolCapability('edit')).toBe('write')
      expect(getToolCapability('write')).toBe('write')
    })

    it('bash 归为 bash', () => {
      expect(getToolCapability('bash')).toBe('bash')
    })

    it('todo_write 归为 readonly（不写文件系统）', () => {
      expect(getToolCapability('todo_write')).toBe('readonly')
    })

    it('未知工具归为 unknown', () => {
      expect(getToolCapability('some_future_tool')).toBe('unknown')
    })
  })

  describe('isToolVisibleInMode', () => {
    it('default / auto 模式下所有工具可见', () => {
      expect(isToolVisibleInMode('default', 'bash')).toBe(true)
      expect(isToolVisibleInMode('auto', 'edit')).toBe(true)
    })

    it('plan 模式下 todo_write 可见', () => {
      expect(isToolVisibleInMode('plan', 'todo_write')).toBe(true)
    })

    it('plan 模式下只读工具可见', () => {
      expect(isToolVisibleInMode('plan', 'read')).toBe(true)
      expect(isToolVisibleInMode('plan', 'ls')).toBe(true)
    })

    it('plan 模式下写类工具不可见', () => {
      expect(isToolVisibleInMode('plan', 'edit')).toBe(false)
      expect(isToolVisibleInMode('plan', 'write')).toBe(false)
    })
  })

  describe('isModeHiddenWriteTool', () => {
    it('plan 模式下 todo_write 不被隐藏', () => {
      expect(isModeHiddenWriteTool('plan', 'todo_write')).toBe(false)
    })

    it('plan 模式下 write/edit/bash 会被隐藏', () => {
      expect(isModeHiddenWriteTool('plan', 'edit')).toBe(true)
      expect(isModeHiddenWriteTool('plan', 'write')).toBe(true)
      expect(isModeHiddenWriteTool('plan', 'bash')).toBe(true)
    })

    it('default / auto 模式下没有工具被隐藏', () => {
      expect(isModeHiddenWriteTool('default', 'bash')).toBe(false)
      expect(isModeHiddenWriteTool('auto', 'edit')).toBe(false)
    })
  })
})

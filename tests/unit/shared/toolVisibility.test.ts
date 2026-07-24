/**
 * toolVisibility 单元测试
 *
 * 重点验证：todo_write 被显式归类为 readonly，plan 模式下可见且不被当作 write/bash 隐藏。
 */
import { describe, expect, it } from 'vitest'
import {
  getModeVisibleTools,
  getToolCapability,
  isToolVisibleInMode,
  isModeHiddenWriteTool
} from '../../../src/shared/session/toolVisibility'

describe('toolVisibility', () => {
  describe('getToolCapability', () => {
    it('读类工具归为 readonly', () => {
      expect(getToolCapability('ls')).toBe('readonly')
      expect(getToolCapability('read')).toBe('readonly')
      expect(getToolCapability('grep')).toBe('readonly')
      expect(getToolCapability('find')).toBe('readonly')
      expect(getToolCapability('web_search')).toBe('readonly')
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

    it('askQuestion 归为 readonly（用户交互工具，无副作用，所有模式放行且 plan 可见）', () => {
      // 回归保护：曾因未分类落到 unknown→被权限层当 bash 处理，default 模式误弹"执行前确认"
      expect(getToolCapability('askQuestion')).toBe('readonly')
    })

    it('save_plan 与 switch_mode 使用独立能力分类', () => {
      expect(getToolCapability('save_plan')).toBe('plan-artifact')
      expect(getToolCapability('switch_mode')).toBe('mode-transition')
    })

    it('task / invoke_skill 归为 orchestration（编排类，派遣动作本身无副作用）', () => {
      expect(getToolCapability('task')).toBe('orchestration')
      expect(getToolCapability('invoke_skill')).toBe('orchestration')
    })

    it('未知工具归为 unknown', () => {
      expect(getToolCapability('some_future_tool')).toBe('unknown')
    })
  })

  describe('isToolVisibleInMode', () => {
    it('default / compose 模式下所有工具可见', () => {
      expect(isToolVisibleInMode('default', 'bash')).toBe(true)
      expect(isToolVisibleInMode('compose', 'edit')).toBe(true)
    })

    it('plan 模式下 todo_write 可见', () => {
      expect(isToolVisibleInMode('plan', 'todo_write')).toBe(true)
    })

    it('plan 模式下可见受限计划产物和模式切换', () => {
      expect(isToolVisibleInMode('plan', 'save_plan')).toBe(true)
      expect(isToolVisibleInMode('plan', 'switch_mode')).toBe(true)
    })

    it('plan 模式下只读工具可见', () => {
      expect(isToolVisibleInMode('plan', 'read')).toBe(true)
      expect(isToolVisibleInMode('plan', 'ls')).toBe(true)
      expect(isToolVisibleInMode('plan', 'web_search')).toBe(true)
    })

    it('plan 模式下写类工具不可见', () => {
      expect(isToolVisibleInMode('plan', 'edit')).toBe(false)
      expect(isToolVisibleInMode('plan', 'write')).toBe(false)
      expect(isToolVisibleInMode('plan', 'task')).toBe(false)
    })

    it('compose 不暴露普通模式切换', () => {
      expect(isToolVisibleInMode('compose', 'switch_mode')).toBe(false)
    })

    it('同一过滤器可同时驱动 native schema 与 XML 工具目录', () => {
      const tools = ['read', 'write', 'save_plan', 'switch_mode', 'task']
        .map(name => ({ name }))
      expect(getModeVisibleTools('plan', tools).map(tool => tool.name)).toEqual([
        'read',
        'save_plan',
        'switch_mode'
      ])
    })
  })

  describe('isModeHiddenWriteTool', () => {
    it('plan 模式下 todo_write 不被隐藏', () => {
      expect(isModeHiddenWriteTool('plan', 'todo_write')).toBe(false)
      expect(isModeHiddenWriteTool('plan', 'save_plan')).toBe(false)
    })

    it('plan 模式下 write/edit/bash 会被隐藏', () => {
      expect(isModeHiddenWriteTool('plan', 'edit')).toBe(true)
      expect(isModeHiddenWriteTool('plan', 'write')).toBe(true)
      expect(isModeHiddenWriteTool('plan', 'bash')).toBe(true)
    })

    it('default / compose 模式下没有工具被隐藏', () => {
      expect(isModeHiddenWriteTool('default', 'bash')).toBe(false)
      expect(isModeHiddenWriteTool('compose', 'edit')).toBe(false)
    })
  })
})

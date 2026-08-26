/**
 * toolVisibility 单元测试
 *
 * 可见性按 effects 收窄：plan 隐藏写文件 / shell / 编排，保留网络读取与会话状态工具。
 */
import { describe, expect, it } from 'vitest'
import {
  getModeVisibleTools,
  getRuntimeVisibleTools,
  isToolVisibleInMode,
  isModeHiddenWriteTool
} from '../../../src/shared/session/toolVisibility'

describe('toolVisibility', () => {
  describe('isToolVisibleInMode', () => {
    it('default / compose 暴露常规工具，plan 隐藏写入类', () => {
      expect(isToolVisibleInMode('default', 'bash')).toBe(true)
      expect(isToolVisibleInMode('compose', 'edit')).toBe(true)
      expect(isToolVisibleInMode('plan', 'bash')).toBe(false)
      expect(isToolVisibleInMode('plan', 'read')).toBe(true)
    })

    it('stage_transition 仅 compose 可见', () => {
      expect(isToolVisibleInMode('compose', 'stage_transition')).toBe(true)
      expect(isToolVisibleInMode('default', 'stage_transition')).toBe(false)
      expect(isToolVisibleInMode('plan', 'stage_transition')).toBe(false)
    })

    it('getModeVisibleTools 过滤掉非 compose 下的 stage_transition', () => {
      const tools = ['read', 'stage_transition', 'write'].map(name => ({ name }))
      expect(getModeVisibleTools('compose', tools).map(t => t.name)).toEqual([
        'read',
        'stage_transition',
        'write'
      ])
      expect(getModeVisibleTools('default', tools).map(t => t.name)).toEqual(['read', 'write'])
      expect(getModeVisibleTools('plan', tools).map(t => t.name)).toEqual(['read'])
    })

    it('plan 模式下 todo_write 可见', () => {
      expect(isToolVisibleInMode('plan', 'todo_write')).toBe(true)
    })

    it('plan 模式下 shell_session 可见（default 起的进程切 plan 后不能失明）', () => {
      expect(isToolVisibleInMode('plan', 'shell_session')).toBe(true)
      expect(isToolVisibleInMode('default', 'shell_session')).toBe(true)
    })

    it('plan 模式下可见受限计划产物和模式切换', () => {
      expect(isToolVisibleInMode('plan', 'save_plan')).toBe(true)
      expect(isToolVisibleInMode('plan', 'switch_mode')).toBe(true)
    })

    it('plan 模式下只读与网络工具可见', () => {
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

    it('只读能力上限独立于产品模式收窄工具面，并保留终端观察动作', () => {
      const tools = ['read', 'write', 'bash', 'shell_session', 'task', 'web_search']
        .map(name => ({ name }))
      expect(getRuntimeVisibleTools('default', tools, 'read_only').map(tool => tool.name)).toEqual([
        'read',
        'shell_session',
        'web_search'
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

    it('plan 模式下 shell_session 卡片照常渲染（read 观察是合法操作，write 由权限层按 action 拒绝）', () => {
      expect(isModeHiddenWriteTool('plan', 'shell_session')).toBe(false)
    })

    it('default / compose 模式下没有工具被隐藏', () => {
      expect(isModeHiddenWriteTool('default', 'bash')).toBe(false)
      expect(isModeHiddenWriteTool('compose', 'edit')).toBe(false)
    })
  })
})

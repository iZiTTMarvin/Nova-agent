import { describe, expect, it } from 'vitest'
import { isToolVisibleInMode } from '../../../../src/shared/session/toolVisibility'
import { createLearnToolAuthorizationPolicy } from '../../../../src/runtime/learning/policy/createLearnToolAuthorizationPolicy'

describe('learn 工具门禁', () => {
  const policy = createLearnToolAuthorizationPolicy()

  it('learn 仅暴露白名单工具（含会话内只读归档恢复工具）', () => {
    expect(isToolVisibleInMode('learn', 'read')).toBe(true)
    expect(isToolVisibleInMode('learn', 'archive_read')).toBe(true)
    expect(isToolVisibleInMode('learn', 'history_read')).toBe(true)
    expect(isToolVisibleInMode('learn', 'present_visualization')).toBe(true)
    expect(isToolVisibleInMode('learn', 'learning_checkpoint')).toBe(true)
    expect(isToolVisibleInMode('learn', 'bash')).toBe(false)
    expect(isToolVisibleInMode('learn', 'switch_mode')).toBe(false)
  })

  it('full_access 不能解除 learn 产品只读，会话内归档读取放行', () => {
    expect(policy('bash').allowed).toBe(false)
    expect(policy('write').allowed).toBe(false)
    expect(policy('task').allowed).toBe(false)
    expect(policy('archive_read')).toMatchObject({ allowed: true })
    expect(policy('history_read')).toMatchObject({ allowed: true })
    expect(policy('present_visualization').allowed).toBe(true)
    expect(policy('learning_checkpoint').allowed).toBe(true)
  })

  it('跨会话长期记忆工具在 learn 模式下均不可见且被硬禁止拒绝', () => {
    for (const toolName of ['memory_read', 'memory_search', 'memory_manage']) {
      expect(isToolVisibleInMode('learn', toolName)).toBe(false)
      expect(policy(toolName)).toEqual({
        allowed: false,
        reason: '学习模式不允许该工具'
      })
    }
  })
})

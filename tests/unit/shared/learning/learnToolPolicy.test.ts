import { describe, expect, it } from 'vitest'
import { isToolVisibleInMode } from '../../../../src/shared/session/toolVisibility'
import { createLearnToolAuthorizationPolicy } from '../../../../src/runtime/learning/policy/createLearnToolAuthorizationPolicy'

describe('learn 工具门禁', () => {
  const policy = createLearnToolAuthorizationPolicy()

  it('learn 仅暴露白名单工具', () => {
    expect(isToolVisibleInMode('learn', 'read')).toBe(true)
    expect(isToolVisibleInMode('learn', 'learning_checkpoint')).toBe(true)
    expect(isToolVisibleInMode('learn', 'bash')).toBe(false)
    expect(isToolVisibleInMode('learn', 'switch_mode')).toBe(false)
  })

  it('full_access 不能解除 learn 产品只读', () => {
    expect(policy('bash').allowed).toBe(false)
    expect(policy('write').allowed).toBe(false)
    expect(policy('task').allowed).toBe(false)
    expect(policy('learning_checkpoint').allowed).toBe(true)
  })
})

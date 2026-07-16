import { describe, expect, it } from 'vitest'
import {
  getXForgeStageBinding,
  XFORGE_STAGE_BINDINGS
} from '../../../../../src/runtime/workflow/xforge'

describe('XForge stage binding', () => {
  it('只绑定阶段方法和 Runtime 执行语义，不携带工具权限表', () => {
    expect(getXForgeStageBinding('brainstorm')).toEqual({
      stage: 'brainstorm',
      method: 'br-brainstorming',
      askQuestionRequired: true
    })
    expect(getXForgeStageBinding('test')).toEqual({
      stage: 'test',
      method: 'runtime-test-gate',
      runtimeControlledCommandsOnly: true
    })
    expect(getXForgeStageBinding('review')).toEqual({
      stage: 'review',
      method: 'review-subagent',
      readonlySnapshotOnly: true
    })
    for (const binding of Object.values(XFORGE_STAGE_BINDINGS)) {
      expect(binding).not.toHaveProperty('allowedCapabilities')
    }
  })
})

import { describe, expect, it } from 'vitest'
import { getLearnCoachRoleMaterial } from '../../../../src/runtime/learning/teaching/coachRoleMaterial'
import { learningSessionAgentBinding } from '../../../../src/main/agent/runtime/sessionAgentBinding/learningBinding'

describe('learn 内置教练材料', () => {
  it('binding 提供角色材料且不要求 Skill', () => {
    const material = learningSessionAgentBinding.extendAgentRole?.({
      sessionStore: {} as never,
      sessionId: 's',
      projectPath: '/p'
    })
    expect(material).toBe(getLearnCoachRoleMaterial())
    expect(material).toContain('learning_checkpoint')
    expect(material).toContain('learning_assess')
    expect(material).toContain('cursorVersion')
    expect(material).toContain('严禁考察死记硬背')
    expect(material).toContain('不要复述用户原话')
    expect(material?.toLowerCase()).not.toContain('skill')
  })
})

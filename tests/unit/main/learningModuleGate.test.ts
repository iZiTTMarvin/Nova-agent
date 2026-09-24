import { describe, expect, it } from 'vitest'
import {
  assertLearningModuleAvailable,
  setLearningModuleAssembledForTests
} from '../../../src/main/agent/runtime/learningModuleGate'

describe('learningModuleGate', () => {
  it('移除学习装配时 learn 会话 fail-closed', () => {
    setLearningModuleAssembledForTests(false)
    expect(() => assertLearningModuleAvailable('learn')).toThrow('此构建不支持学习模块')
    assertLearningModuleAvailable('default')
    setLearningModuleAssembledForTests(true)
  })
})

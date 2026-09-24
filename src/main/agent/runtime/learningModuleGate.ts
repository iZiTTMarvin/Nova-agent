import type { Mode } from '../../../shared/session/types'

let assembled = true

export function isLearningModuleAssembled(): boolean {
  return assembled
}

/** 测试专用：模拟移除学习装配时的 fail-closed。 */
export function setLearningModuleAssembledForTests(value: boolean): void {
  assembled = value
}

export function assertLearningModuleAvailable(mode: Mode): void {
  if (mode === 'learn' && !assembled) {
    throw new Error('此构建不支持学习模块')
  }
}

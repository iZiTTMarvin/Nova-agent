import type { XForgeStage } from './types'

/** live stage/delivery host 共享的可变运行时槽位；由 composition root 持有唯一实例。 */
export interface XForgeLiveHostRuntime {
  activeStage: XForgeStage
  activeStepId: string
  activeSkillBody: string
}

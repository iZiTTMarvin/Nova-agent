import type { SessionAgentBinding } from './types'
import type { AgentLoop } from '../../../../runtime/agent'
import { getModeInstruction } from '../../../../runtime/agent/promptBuilder/modeInstruction'
import { createLearnToolAuthorizationPolicy } from '../../../../runtime/learning/policy/createLearnToolAuthorizationPolicy'
import { getLearnCoachRoleMaterial } from '../../../../runtime/learning/teaching/coachRoleMaterial'
import { registerLearningTools } from '../registerLearningTools'
import { getLearningProgressOrNull } from '../../../learning/LearningDbHost'

export const learningSessionAgentBinding: SessionAgentBinding = {
  mode: 'learn',
  extendAgentRole() {
    return getLearnCoachRoleMaterial()
  },
  applyToAgentLoop(loop: AgentLoop, _ctx) {
    loop.setModeInstructionProvider(() => getModeInstruction('learn'))
    const policy = createLearnToolAuthorizationPolicy()
    loop.setToolAuthorizationPolicy(policy)
    return policy
  },
  registerDomainTools(registry) {
    registerLearningTools(registry, { getProgress: getLearningProgressOrNull })
    return () => {}
  }
}

import type { AgentLoop } from '../../../../runtime/agent'
import { buildDomainAgentRole } from '../../../../runtime/agent'
import type { SessionAgentBinding } from './types'
import { projectLearningPreset } from '../../../../runtime/learning/preset/projectLearningPreset'
import { registerLearningTools } from '../registerLearningTools'
import { getLearningProgressOrNull } from '../../../learning/LearningDbHost'

export const learningSessionAgentBinding: SessionAgentBinding = {
  mode: 'learn',
  buildPromptProfile(ctx) {
    return {
      agentRole: buildDomainAgentRole(projectLearningPreset.roleMaterial, ctx.projectPath),
      baseRules: projectLearningPreset.baseRules,
      taskPolicy: '',
      skillContext: '',
      modeInstruction: projectLearningPreset.renderTurnInstruction
    }
  },
  applyToAgentLoop(loop: AgentLoop) {
    const policy = projectLearningPreset.createToolAuthorizationPolicy()
    loop.setToolAuthorizationPolicy(policy)
    return policy
  },
  registerDomainTools(registry) {
    registerLearningTools(registry, { getProgress: getLearningProgressOrNull })
    return () => {}
  }
}

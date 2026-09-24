import type { SessionAgentBinding } from './types'
import type { AgentLoop } from '../../../../runtime/agent'
import { getModeInstruction } from '../../../../runtime/agent/promptBuilder/modeInstruction'
import { createLearnToolAuthorizationPolicy } from '../../../../runtime/learning/policy/createLearnToolAuthorizationPolicy'
import { registerLearningTools } from '../registerLearningTools'
import type { ToolRegistry } from '../../../../runtime/tools/ToolRegistry'

export const learningSessionAgentBinding: SessionAgentBinding = {
  mode: 'learn',
  applyToAgentLoop(loop: AgentLoop) {
    loop.setModeInstructionProvider(() => getModeInstruction('learn'))
    const policy = createLearnToolAuthorizationPolicy()
    loop.setToolAuthorizationPolicy(policy)
    return policy
  },
  registerDomainTools(registry: ToolRegistry) {
    registerLearningTools(registry)
    return () => {}
  }
}

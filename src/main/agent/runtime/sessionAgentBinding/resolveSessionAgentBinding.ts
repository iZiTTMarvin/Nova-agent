import type { Mode } from '../../../../shared/session/types'
import type { SessionAgentBinding } from './types'
import { getDevelopmentSessionAgentBinding } from './developmentBinding'
import { learningSessionAgentBinding } from './learningBinding'
import { assertLearningModuleAvailable } from '../learningModuleGate'

export function resolveSessionAgentBinding(mode: Mode): SessionAgentBinding {
  if (mode === 'learn') {
    assertLearningModuleAvailable(mode)
    return learningSessionAgentBinding
  }
  return getDevelopmentSessionAgentBinding(mode)
}

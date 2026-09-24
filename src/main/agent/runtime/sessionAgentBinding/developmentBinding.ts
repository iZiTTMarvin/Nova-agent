import type { DevelopmentMode } from '../../../../shared/session/mode'
import type { SessionAgentBinding } from './types'
import {
  createComposeModeInstructionProvider,
  createComposeStageToolPolicy
} from '../composeStageWiring'

function createBinding(mode: DevelopmentMode): SessionAgentBinding {
  return {
    mode,
    applyToAgentLoop(loop, ctx) {
      if (mode !== 'compose') {
        return null
      }
      loop.setModeInstructionProvider(
        createComposeModeInstructionProvider(ctx.sessionStore, ctx.sessionId)
      )
      const policy = createComposeStageToolPolicy(ctx.sessionStore, ctx.sessionId)
      loop.setToolAuthorizationPolicy(policy)
      return policy
    },
    registerDomainTools() {
      return () => {}
    }
  }
}

const DEFAULT_BINDING = createBinding('default')
const PLAN_BINDING = createBinding('plan')
const COMPOSE_BINDING = createBinding('compose')

export function getDevelopmentSessionAgentBinding(mode: DevelopmentMode): SessionAgentBinding {
  if (mode === 'compose') return COMPOSE_BINDING
  if (mode === 'plan') return PLAN_BINDING
  return DEFAULT_BINDING
}

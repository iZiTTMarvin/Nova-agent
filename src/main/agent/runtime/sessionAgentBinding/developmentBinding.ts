import type { DevelopmentMode } from '../../../../shared/session/mode'
import type { SessionAgentBinding, SessionPromptContext, SessionPromptProfile } from './types'
import {
  buildSkillContextForMode,
  buildStableSystemPrompt,
  renderBaseRules,
  renderMinimalEngineeringPolicy
} from '../../../../runtime/agent'
import {
  createComposeModeInstructionProvider,
  createComposeStageToolPolicy
} from '../composeStageWiring'

function createBinding(mode: DevelopmentMode): SessionAgentBinding {
  return {
    mode,
    buildPromptProfile(ctx: SessionPromptContext): SessionPromptProfile {
      return {
        agentRole: buildStableSystemPrompt({ workingDir: ctx.projectPath }),
        baseRules: renderBaseRules(),
        taskPolicy: renderMinimalEngineeringPolicy(),
        skillContext: buildSkillContextForMode(mode, ctx.listSkillsForContext),
        modeInstruction:
          mode === 'compose'
            ? createComposeModeInstructionProvider(ctx.sessionStore, ctx.sessionId)
            : null
      }
    },
    applyToAgentLoop(loop, ctx) {
      if (mode !== 'compose') {
        return null
      }
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

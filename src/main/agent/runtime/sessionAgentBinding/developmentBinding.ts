import type { DevelopmentMode } from '../../../../shared/session/mode'
import type { SessionAgentBinding, SessionPromptContext, SessionPromptProfile } from './types'
import {
  buildSkillContextForMode,
  buildStableSystemPrompt,
  renderBaseRules,
  renderMinimalEngineeringPolicy
} from '../../../../runtime/agent'

function createBinding(mode: DevelopmentMode): SessionAgentBinding {
  return {
    mode,
    buildPromptProfile(ctx: SessionPromptContext): SessionPromptProfile {
      return {
        agentRole: buildStableSystemPrompt({ workingDir: ctx.projectPath }),
        baseRules: renderBaseRules(),
        taskPolicy: renderMinimalEngineeringPolicy(),
        skillContext: buildSkillContextForMode(mode, ctx.listSkillsForContext),
        modeInstruction: null
      }
    },
    applyToAgentLoop() {
      return null
    },
    registerDomainTools() {
      return () => {}
    }
  }
}

const DEFAULT_BINDING = createBinding('default')
const PLAN_BINDING = createBinding('plan')
const PILOT_BINDING = createBinding('pilot')

export function getDevelopmentSessionAgentBinding(mode: DevelopmentMode): SessionAgentBinding {
  if (mode === 'pilot') return PILOT_BINDING
  if (mode === 'plan') return PLAN_BINDING
  return DEFAULT_BINDING
}

import type { AgentLoop, SystemPromptLayers } from '../../../../runtime/agent'
import type { ToolRegistry } from '../../../../runtime/tools/ToolRegistry'
import type { ToolAuthorizationPolicy } from '../../../../runtime/permissions/PermissionCoordinator'
import type { SessionStore } from '../../../../runtime/sessions'
import type { SkillManifest } from '../../../../runtime/skills/types'
import type { Mode } from '../../../../shared/session/types'
import type { DevelopmentMode } from '../../../../shared/session/mode'

export interface SessionAgentBindingContext {
  readonly sessionStore: SessionStore
  readonly sessionId: string
  readonly projectPath: string
}

export interface SessionPromptContext extends SessionAgentBindingContext {
  readonly listSkillsForContext: (profile?: string) => SkillManifest[]
}

export type ModeInstructionProvider = () => string

export type SessionPromptProfile =
  Required<Pick<SystemPromptLayers, 'agentRole' | 'baseRules' | 'taskPolicy' | 'skillContext'>> & {
    /** null：由 AgentLoop 按当前开发模式动态生成，plan/default 可在运行中切换。 */
    readonly modeInstruction: ModeInstructionProvider | null
  }

interface SessionAgentBindingOf<M extends Mode, P extends SessionPromptProfile> {
  readonly mode: M
  buildPromptProfile(ctx: SessionPromptContext): P
  applyToAgentLoop(loop: AgentLoop, ctx: SessionAgentBindingContext): ToolAuthorizationPolicy | null
  registerDomainTools(registry: ToolRegistry, ctx: SessionAgentBindingContext): () => void
  assertTurnAdmissible?(ctx: SessionAgentBindingContext): void
}

export type SessionAgentBinding =
  | SessionAgentBindingOf<DevelopmentMode, SessionPromptProfile>
  | SessionAgentBindingOf<
      Exclude<Mode, DevelopmentMode>,
      SessionPromptProfile & { readonly modeInstruction: ModeInstructionProvider }
    >

import type { AgentLoop } from '../../../../runtime/agent'
import type { ToolRegistry } from '../../../../runtime/tools/ToolRegistry'
import type { ToolAuthorizationPolicy } from '../../../../runtime/permissions/PermissionCoordinator'
import type { SessionStore } from '../../../../runtime/sessions'
import type { Mode } from '../../../../shared/session/types'

export interface SessionAgentBindingContext {
  readonly sessionStore: SessionStore
  readonly sessionId: string
  readonly projectPath: string
}

export interface SessionAgentBinding {
  readonly mode: Mode
  applyToAgentLoop(loop: AgentLoop, ctx: SessionAgentBindingContext): ToolAuthorizationPolicy | null
  registerDomainTools(registry: ToolRegistry, ctx: SessionAgentBindingContext): () => void
  assertTurnAdmissible?(ctx: SessionAgentBindingContext): void
}

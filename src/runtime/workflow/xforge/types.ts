/**
 * XForge 阶段状态机与 Resolver 的共享类型。
 *
 * 不变量：阶段编排是固定生命周期上的顺序工作流；模型不得生成任意拓扑。
 */

export type {
  XForgeStage,
  XForgeStartStage,
  XForgeTerminalStage,
  ScopePassRef,
  StageResolverInput,
  StageResolverResult,
  StageControllerFacts,
  StageControllerContext,
  TransitionRejectCode,
  TransitionBudgetDelta,
  StageTransitionResult
} from '../../../shared/xforge/types'

export {
  XFORGE_TERMINAL_STAGES,
  SCOPE_CORRECTION_BUDGET,
  DELIVERY_TEST_FIX_BUDGET,
  REVIEW_REMEDIATION_BUDGET
} from '../../../shared/xforge/types'

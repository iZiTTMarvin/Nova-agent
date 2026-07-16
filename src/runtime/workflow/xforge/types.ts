/**
 * XForge 阶段状态机与 Resolver 的共享类型。
 *
 * 不变量：阶段编排是固定生命周期上的顺序工作流；模型不得生成任意拓扑。
 */

/** XForge 全量阶段（含等待与终态） */
export type XForgeStage =
  | 'resolve'
  | 'brainstorm'
  | 'plan'
  | 'scope_check'
  | 'implement'
  | 'test'
  | 'review'
  | 'fix'
  | 'report'
  | 'waiting_user'
  | 'completed'
  | 'failed'
  | 'cancelled'

/** 可由 Resolver 选出的业务起点（不含 resolve / fix / 终态） */
export type XForgeStartStage =
  | 'brainstorm'
  | 'plan'
  | 'scope_check'
  | 'implement'
  | 'test'
  | 'review'

/** 终态：写入后拒绝任何复活转移 */
export type XForgeTerminalStage = 'completed' | 'failed' | 'cancelled'

export const XFORGE_TERMINAL_STAGES: readonly XForgeTerminalStage[] = [
  'completed',
  'failed',
  'cancelled'
] as const

/** Scope 修正：每 run 最多 2 轮 */
export const SCOPE_CORRECTION_BUDGET = 2
/** 交付 Test-Fix：每 run 最多 3 轮 */
export const DELIVERY_TEST_FIX_BUDGET = 3
/** Review Remediation：每 run 最多 2 轮 */
export const REVIEW_REMEDIATION_BUDGET = 2

/** 绑定 Plan Version + Workspace Revision 的 Scope Pass */
export interface ScopePassRef {
  planVersion: number
  workspaceRevision: number
}

/**
 * StageResolver 输入：以结构化信号表达确定性事实。
 * 本窄纵切不解析自然语言，也不调用模型；语义补充结果由调用方注入。
 */
export interface StageResolverInput {
  /** Review Only：只审查且禁止修改（最高优先级） */
  reviewOnly?: boolean
  /** 用户明确声称代码已改完并请求测试/检查 */
  codeReadyForTest?: boolean
  /** 明确 Bug 修复，且未声明实现已完成 */
  isBugfix?: boolean
  /** 引用设计文档，但尚无 Validated Plan（设计-only） */
  hasDesignOnlyDoc?: boolean
  /** 模糊新需求且无既有计划信号 */
  isVagueNewRequirement?: boolean
  /** 当前是否存在 Validated Plan */
  hasValidatedPlan?: boolean
  /** 当前 Plan Version（有 Validated Plan 时提供） */
  planVersion?: number
  /** 当前 Workspace Revision */
  workspaceRevision?: number
  /** 绑定当前 Plan Version + Workspace Revision 的 Scope Pass；缺省或版本不匹配视为无效 */
  scopePass?: ScopePassRef | null
  /** 工作区 dirty；单独出现不得把入口改成 test */
  workspaceDirty?: boolean
  /**
   * 用户明确指定的期望起点。
   * 仍须经 Validated Plan / Scope Pass 门禁夹紧。
   */
  requestedStartStage?: XForgeStartStage
  /**
   * 至多一次模型语义补充的结果。
   * - 未提供：不依赖模型
   * - 'failed'：分类失败 → 保守 brainstorm（或在其它确定性信号下已解析为 plan）
   * - 'brainstorm' | 'plan'：采用该分类（仍受门禁夹紧）
   */
  modelSemanticHint?: 'brainstorm' | 'plan' | 'failed'
}

export interface StageResolverResult {
  startStage: XForgeStartStage
  reviewOnly: boolean
  /** 因自适应跳过的前置业务阶段 */
  skippedStages: XForgeStartStage[]
  reason: string
  /** Bug 修复计划路径（不跳过 Scope） */
  repairPath?: boolean
}

/** StageController 门禁与预算事实 */
export interface StageControllerFacts {
  reviewOnly: boolean
  hasValidatedPlan: boolean
  /** Scope Pass 是否绑定当前 Plan Version + Workspace Revision */
  hasValidScopePass: boolean
  /** 已使用的 Scope 修正轮数 */
  scopeCorrectionUsed: number
  /** 已使用的交付 Test-Fix 轮数 */
  deliveryTestFixUsed: number
  /** 已使用的 Review Remediation 轮数 */
  reviewRemediationUsed: number
}

export interface StageControllerContext extends StageControllerFacts {
  currentStage: XForgeStage
}

export type TransitionRejectCode =
  | 'illegal_transition'
  | 'terminal_frozen'
  | 'review_only_forbids_fix'

export interface TransitionBudgetDelta {
  scopeCorrection?: number
  deliveryTestFix?: number
  reviewRemediation?: number
}

export type StageTransitionResult =
  | {
      ok: true
      from: XForgeStage
      to: XForgeStage
      /** 门禁夹紧前的请求目标；未夹紧时省略 */
      requestedTo?: XForgeStage
      reason: string
      budgetDelta?: TransitionBudgetDelta
    }
  | {
      ok: false
      from: XForgeStage
      requestedTo: XForgeStage
      code: TransitionRejectCode
      reason: string
    }

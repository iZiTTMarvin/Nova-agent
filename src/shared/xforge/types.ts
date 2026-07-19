/**
 * XForge 阶段状态机与 Run 快照的共享可序列化 DTO。
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
 */
export interface StageResolverInput {
  reviewOnly?: boolean
  codeReadyForTest?: boolean
  isBugfix?: boolean
  hasDesignOnlyDoc?: boolean
  isVagueNewRequirement?: boolean
  isNonDevRequest?: boolean
  hasValidatedPlan?: boolean
  planVersion?: number
  workspaceRevision?: number
  scopePass?: ScopePassRef | null
  workspaceDirty?: boolean
  requestedStartStage?: XForgeStartStage
  modelSemanticHint?: 'brainstorm' | 'plan' | 'failed'
}

export interface StageResolverResult {
  startStage: XForgeStartStage
  reviewOnly: boolean
  skippedStages: XForgeStartStage[]
  reason: string
  terminalSummary?: string
  repairPath?: boolean
}

/** StageController 门禁与预算事实 */
export interface StageControllerFacts {
  reviewOnly: boolean
  hasValidatedPlan: boolean
  hasValidScopePass: boolean
  scopeCorrectionUsed: number
  deliveryTestFixUsed: number
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

export interface XForgePlanTask {
  id: string
  title: string
  acceptance: string[]
}

export interface XForgeValidatedPlan {
  version: number
  goal: string
  constraints: string[]
  nonGoals: string[]
  repositoryFacts: string[]
  changeScope: string[]
  tasks: XForgePlanTask[]
  acceptanceMap: Record<string, string[]>
  verificationChecklist: string[]
  risks: string[]
}

export interface XForgePlanValidation {
  valid: boolean
  missing: string[]
}

export interface XForgeWorkspaceBaselineEntry {
  path: string
  kind: 'tracked' | 'untracked'
  contentHash: string | null
}

export interface XForgeWorkspaceBaselineV1 {
  schemaVersion: 1
  capturedAt: string
  headOid: string | null
  entries: XForgeWorkspaceBaselineEntry[]
}

export type XForgeReviewTarget =
  | { kind: 'run_effects' }
  | { kind: 'existing_worktree' }

/** 阶段产物引用占位（路径/摘要；完整正文落盘在 compose 产物目录） */
export interface XForgeStageArtifactRef {
  stage: XForgeStage
  artifactId: string
  path?: string
  summary?: string
}

/** 证据引用占位 */
export interface XForgeEvidenceRef {
  kind: string
  path?: string
  note?: string
  unverified?: boolean
}

export type XForgeTaskStatus = 'pending' | 'in_progress' | 'done' | 'unverified' | 'skipped' | 'failed'

export interface XForgeTaskState {
  id: string
  title: string
  status: XForgeTaskStatus
  acceptance: string[]
  attempts: number
  evidenceRefs: XForgeEvidenceRef[]
  failureReason?: string
}

export interface XForgeMainSessionState {
  goal: string
  constraints: string[]
  nonGoals: string[]
  userDecisions: string[]
}

export interface XForgeScopeFindingState {
  severity: 'critical' | 'high' | 'medium' | 'low'
  location: string
  summary: string
  evidence: string
  suggestion: string
  unverified?: boolean
}

export interface XForgeWorkspaceFingerprint {
  revision: number
  digest: string
  capturedAt: number
}

export interface XForgeWriteBoundary {
  checkpointRef: string
  fingerprint: XForgeWorkspaceFingerprint
  preparedAt: number
}

export interface XForgeFileEffect {
  path: string
  receiptId?: string
  status?: 'committed' | 'prepared'
}

export interface XForgeControlledCommandEvidence {
  command: string
  required: boolean
  exitCode: number | null
  timedOut: boolean
  blockedReason?: string
  evidenceRef: XForgeEvidenceRef
}

export interface XForgeTestEvidenceState {
  workspaceRevision: number
  fingerprint: XForgeWorkspaceFingerprint
  commands: XForgeControlledCommandEvidence[]
  passed: boolean
  capturedAt: number
}

export interface XForgeReviewFindingState {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'nit'
  location: string
  summary: string
  evidence: string
  suggestion?: string
  unverified?: boolean
}

export interface XForgeReportFactsState {
  runId: string
  finalWorkspaceRevision: number
  testPassed: boolean
  testCommands: XForgeControlledCommandEvidence[]
  completedTasks: string[]
  unverifiedTasks: string[]
  skippedTasks: Array<{ id: string; reason: string }>
  blockingFindings: XForgeReviewFindingState[]
  technicalDebt: XForgeReviewFindingState[]
  budgets: {
    scopeCorrectionUsed: number
    deliveryTestFixUsed: number
    reviewRemediationUsed: number
  }
  shipRequested: boolean
  notExecuted: Array<'commit' | 'push' | 'deploy' | 'publish'>
}

/** RunSnapshot.xforge 权威字段 */
export interface XForgeRunState {
  currentStage: XForgeStage
  completedStages: XForgeStage[]
  skippedStages: XForgeStage[]
  reviewOnly: boolean
  planVersion: number | null
  validatedPlan: XForgeValidatedPlan | null
  workspaceRevision: number
  hasValidatedPlan: boolean
  hasValidScopePass: boolean
  scopePass: ScopePassRef | null
  scopeCorrectionUsed: number
  deliveryTestFixUsed: number
  reviewRemediationUsed: number
  suspendedStage: XForgeStage | null
  resumeTarget: XForgeStage | null
  waitingReason: string | null
  stageArtifacts: XForgeStageArtifactRef[]
  evidenceRefs: XForgeEvidenceRef[]
  tasks: XForgeTaskState[]
  mainSession: XForgeMainSessionState
  pendingScopeFindings: XForgeScopeFindingState[]
  activeTaskId: string | null
  writeBoundary: XForgeWriteBoundary | null
  testEvidence: XForgeTestEvidenceState | null
  reviewFindings: XForgeReviewFindingState[]
  technicalDebt: XForgeReviewFindingState[]
  reportFacts: XForgeReportFactsState | null
  workspaceBaseline: XForgeWorkspaceBaselineV1 | null
  reviewTarget: XForgeReviewTarget | null
  lastTransitionReason?: string
}

export interface CreateXForgeRunStateOptions {
  reviewOnly?: boolean
  currentStage?: XForgeStage
  planVersion?: number | null
  workspaceRevision?: number
  hasValidatedPlan?: boolean
  hasValidScopePass?: boolean
  scopePass?: ScopePassRef | null
  mainSession?: Partial<XForgeMainSessionState>
}

export interface ApplyXForgeTransitionOptions {
  completedStages?: XForgeStage[]
  skippedStages?: XForgeStage[]
  planVersion?: number | null
  workspaceRevision?: number
  hasValidatedPlan?: boolean
  hasValidScopePass?: boolean
  scopePass?: ScopePassRef | null
  reviewOnly?: boolean
  resumeTarget?: XForgeStage | null
  artifact?: XForgeStageArtifactRef
  evidenceRef?: XForgeEvidenceRef
  tasks?: XForgeTaskState[]
  validatedPlan?: XForgeValidatedPlan | null
  mainSession?: XForgeMainSessionState
  pendingScopeFindings?: XForgeScopeFindingState[]
  activeTaskId?: string | null
  writeBoundary?: XForgeWriteBoundary | null
  testEvidence?: XForgeTestEvidenceState | null
  reviewFindings?: XForgeReviewFindingState[]
  technicalDebt?: XForgeReviewFindingState[]
  reportFacts?: XForgeReportFactsState | null
  workspaceBaseline?: XForgeWorkspaceBaselineV1 | null
  reviewTarget?: XForgeReviewTarget | null
}

export type ApplyXForgeTransitionResult =
  | { ok: true; state: XForgeRunState }
  | {
      ok: false
      code: 'xforge_terminal' | 'transition_rejected' | 'from_mismatch'
      reason: string
    }

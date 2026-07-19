/**
 * XForge Stage Run 在 RunCoordinator snapshot 中的权威状态切片。
 *
 * Renderer 只读投影；写入必须经 RunCoordinator 原子 commit。
 */

import { isTerminalStage } from './stageController'
import type {
  ApplyXForgeTransitionOptions,
  ApplyXForgeTransitionResult,
  CreateXForgeRunStateOptions,
  StageTransitionResult,
  XForgeMainSessionState,
  XForgeReportFactsState,
  XForgeReviewFindingState,
  XForgeRunState,
  XForgeTaskState,
  XForgeTestEvidenceState,
  XForgeValidatedPlan,
  XForgeWriteBoundary
} from '../../../shared/xforge/types'
import { cloneReviewTarget, cloneWorkspaceBaseline } from './workspaceBaseline'

export type {
  XForgeRunState,
  XForgeStageArtifactRef,
  XForgeEvidenceRef,
  XForgeTaskState,
  XForgeTaskStatus,
  XForgeWorkspaceFingerprint,
  XForgeWriteBoundary,
  XForgeFileEffect,
  XForgeControlledCommandEvidence,
  XForgeTestEvidenceState,
  XForgeReviewFindingState,
  XForgeReportFactsState,
  XForgeMainSessionState,
  XForgeScopeFindingState,
  CreateXForgeRunStateOptions,
  ApplyXForgeTransitionOptions,
  ApplyXForgeTransitionResult
} from '../../../shared/xforge/types'

export interface XForgeRunCommitter {
  getSnapshot(runId: string): { xforge?: XForgeRunState | null } | null
  commitXForgeStageTransition(
    runId: string,
    result: StageTransitionResult,
    opts?: ApplyXForgeTransitionOptions
  ): { ok: true; xforge: XForgeRunState } | { ok: false; message: string }
  commitXForgeStatePatch(
    runId: string,
    opts: ApplyXForgeTransitionOptions,
    reason?: string
  ): { ok: true; xforge: XForgeRunState } | { ok: false; message: string }
}

export function createInitialXForgeRunState(
  opts: CreateXForgeRunStateOptions = {}
): XForgeRunState {
  const planVersion = opts.planVersion ?? null
  const workspaceRevision = opts.workspaceRevision ?? 0
  const scopePass = opts.scopePass ?? (
    opts.hasValidScopePass && planVersion !== null
      ? { planVersion, workspaceRevision }
      : null
  )
  return {
    currentStage: opts.currentStage ?? 'resolve',
    completedStages: [],
    skippedStages: [],
    reviewOnly: opts.reviewOnly ?? false,
    planVersion,
    validatedPlan: null,
    workspaceRevision,
    hasValidatedPlan: opts.hasValidatedPlan ?? false,
    hasValidScopePass:
      opts.hasValidScopePass === true &&
      scopePass?.planVersion === planVersion &&
      scopePass.workspaceRevision === workspaceRevision,
    scopePass,
    scopeCorrectionUsed: 0,
    deliveryTestFixUsed: 0,
    reviewRemediationUsed: 0,
    suspendedStage: null,
    resumeTarget: null,
    waitingReason: null,
    stageArtifacts: [],
    evidenceRefs: [],
    tasks: [],
    mainSession: {
      goal: opts.mainSession?.goal ?? '',
      constraints: [...(opts.mainSession?.constraints ?? [])],
      nonGoals: [...(opts.mainSession?.nonGoals ?? [])],
      userDecisions: [...(opts.mainSession?.userDecisions ?? [])]
    },
    pendingScopeFindings: [],
    activeTaskId: null,
    writeBoundary: null,
    testEvidence: null,
    reviewFindings: [],
    technicalDebt: [],
    reportFacts: null,
    workspaceBaseline: null,
    reviewTarget: null
  }
}

/**
 * 将成功的 StageTransitionResult 叠到 XForgeRunState（纯函数，不落盘）。
 * 要求 result.from === prev.currentStage，保证 StageController 当前阶段权威性。
 * 终态阶段拒绝再更新；失败的 transition 原样拒绝。
 */
export function applyXForgeStageTransition(
  prev: XForgeRunState,
  result: StageTransitionResult,
  opts: ApplyXForgeTransitionOptions = {}
): ApplyXForgeTransitionResult {
  if (isTerminalStage(prev.currentStage)) {
    return {
      ok: false,
      code: 'xforge_terminal',
      reason: `终态 ${prev.currentStage} 不可再更新阶段`
    }
  }

  if (!result.ok) {
    return {
      ok: false,
      code: 'transition_rejected',
      reason: result.reason
    }
  }

  if (result.from !== prev.currentStage) {
    return {
      ok: false,
      code: 'from_mismatch',
      reason: `转移来源 ${result.from} 与当前阶段 ${prev.currentStage} 不一致`
    }
  }

  const next = cloneXForgeRunState(prev)
  next.currentStage = result.to
  next.lastTransitionReason = result.reason
  next.scopeCorrectionUsed =
    prev.scopeCorrectionUsed + (result.budgetDelta?.scopeCorrection ?? 0)
  next.deliveryTestFixUsed =
    prev.deliveryTestFixUsed + (result.budgetDelta?.deliveryTestFix ?? 0)
  next.reviewRemediationUsed =
    prev.reviewRemediationUsed + (result.budgetDelta?.reviewRemediation ?? 0)

  if (
    result.from !== 'waiting_user' &&
    result.to !== 'waiting_user' &&
    result.to !== 'failed' &&
    result.to !== 'cancelled' &&
    !next.completedStages.includes(result.from)
  ) {
    next.completedStages.push(result.from)
  }

  applyXForgePatchOptions(next, opts)

  if (result.to === 'waiting_user') {
    next.suspendedStage = result.from
    next.resumeTarget =
      opts.resumeTarget !== undefined ? opts.resumeTarget : result.from
    next.waitingReason = result.reason
  } else {
    next.suspendedStage = null
    next.resumeTarget = null
    next.waitingReason = null
  }

  if (
    result.from === 'scope_check' &&
    result.to === 'implement' &&
    next.hasValidatedPlan &&
    next.planVersion !== null
  ) {
    next.hasValidScopePass = true
    next.scopePass = {
      planVersion: next.planVersion,
      workspaceRevision: next.workspaceRevision
    }
  }

  return { ok: true, state: next }
}

/** 同阶段事实更新的唯一纯函数；不改变 currentStage 和 waiting/resume 语义。 */
export function applyXForgeStatePatch(
  prev: XForgeRunState,
  opts: ApplyXForgeTransitionOptions,
  reason: string
): XForgeRunState {
  const next = cloneXForgeRunState(prev)
  next.lastTransitionReason = reason
  applyXForgePatchOptions(next, opts)
  return next
}

function applyXForgePatchOptions(
  next: XForgeRunState,
  opts: ApplyXForgeTransitionOptions
): void {
  if (opts.planVersion !== undefined) next.planVersion = opts.planVersion
  if (opts.completedStages !== undefined) next.completedStages = [...opts.completedStages]
  if (opts.skippedStages !== undefined) next.skippedStages = [...opts.skippedStages]
  if (opts.workspaceRevision !== undefined) next.workspaceRevision = opts.workspaceRevision
  if (opts.hasValidatedPlan !== undefined) next.hasValidatedPlan = opts.hasValidatedPlan
  if (opts.hasValidScopePass !== undefined) next.hasValidScopePass = opts.hasValidScopePass
  if (opts.scopePass !== undefined) {
    next.scopePass = opts.scopePass ? { ...opts.scopePass } : null
  }
  if (opts.reviewOnly !== undefined) next.reviewOnly = opts.reviewOnly

  if (opts.artifact) next.stageArtifacts.push({ ...opts.artifact })
  if (opts.evidenceRef) next.evidenceRefs.push({ ...opts.evidenceRef })
  if (opts.tasks !== undefined) next.tasks = opts.tasks.map(cloneTaskState)
  if (opts.validatedPlan !== undefined) {
    next.validatedPlan = opts.validatedPlan ? cloneValidatedPlan(opts.validatedPlan) : null
  }
  if (opts.mainSession !== undefined) next.mainSession = cloneMainSession(opts.mainSession)
  if (opts.pendingScopeFindings !== undefined) {
    next.pendingScopeFindings = opts.pendingScopeFindings.map(finding => ({ ...finding }))
  }
  if (opts.activeTaskId !== undefined) next.activeTaskId = opts.activeTaskId
  if (opts.writeBoundary !== undefined) {
    next.writeBoundary = opts.writeBoundary ? cloneWriteBoundary(opts.writeBoundary) : null
  }
  if (opts.testEvidence !== undefined) {
    next.testEvidence = opts.testEvidence ? cloneTestEvidence(opts.testEvidence) : null
  }
  if (opts.reviewFindings !== undefined) {
    next.reviewFindings = opts.reviewFindings.map(cloneReviewFinding)
  }
  if (opts.technicalDebt !== undefined) {
    next.technicalDebt = opts.technicalDebt.map(cloneReviewFinding)
  }
  if (opts.reportFacts !== undefined) {
    next.reportFacts = opts.reportFacts ? cloneReportFacts(opts.reportFacts) : null
  }
  if (opts.workspaceBaseline !== undefined && next.workspaceBaseline === null && opts.workspaceBaseline) {
    next.workspaceBaseline = cloneWorkspaceBaseline(opts.workspaceBaseline)
  }
  if (opts.reviewTarget !== undefined && next.reviewTarget === null && opts.reviewTarget) {
    next.reviewTarget = cloneReviewTarget(opts.reviewTarget)
  }

  if (
    next.scopePass &&
    (next.scopePass.planVersion !== next.planVersion ||
      next.scopePass.workspaceRevision !== next.workspaceRevision)
  ) {
    next.hasValidScopePass = false
  }
}

export function cloneXForgeRunState(state: XForgeRunState): XForgeRunState {
  const mainSession = state.mainSession ?? {
    goal: '',
    constraints: [],
    nonGoals: [],
    userDecisions: []
  }
  return {
    ...state,
    completedStages: [...(state.completedStages ?? [])],
    skippedStages: [...(state.skippedStages ?? [])],
    scopePass: state.scopePass ? { ...state.scopePass } : null,
    stageArtifacts: state.stageArtifacts.map(a => ({ ...a })),
    evidenceRefs: state.evidenceRefs.map(e => ({ ...e })),
    tasks: state.tasks.map(cloneTaskState),
    validatedPlan: state.validatedPlan ? cloneValidatedPlan(state.validatedPlan) : null,
    mainSession: cloneMainSession(mainSession),
    pendingScopeFindings: (state.pendingScopeFindings ?? []).map(finding => ({ ...finding })),
    activeTaskId: state.activeTaskId,
    writeBoundary: state.writeBoundary ? cloneWriteBoundary(state.writeBoundary) : null,
    testEvidence: state.testEvidence ? cloneTestEvidence(state.testEvidence) : null,
    reviewFindings: (state.reviewFindings ?? []).map(cloneReviewFinding),
    technicalDebt: (state.technicalDebt ?? []).map(cloneReviewFinding),
    reportFacts: state.reportFacts ? cloneReportFacts(state.reportFacts) : null,
    workspaceBaseline: state.workspaceBaseline
      ? cloneWorkspaceBaseline(state.workspaceBaseline)
      : null,
    reviewTarget: state.reviewTarget ? cloneReviewTarget(state.reviewTarget) : null
  }
}

function cloneMainSession(state: XForgeMainSessionState): XForgeMainSessionState {
  return {
    goal: state.goal,
    constraints: [...state.constraints],
    nonGoals: [...state.nonGoals],
    userDecisions: [...state.userDecisions]
  }
}

function cloneValidatedPlan(plan: XForgeValidatedPlan): XForgeValidatedPlan {
  return {
    ...plan,
    constraints: [...plan.constraints],
    nonGoals: [...plan.nonGoals],
    repositoryFacts: [...plan.repositoryFacts],
    changeScope: [...plan.changeScope],
    tasks: plan.tasks.map(task => ({
      ...task,
      acceptance: [...task.acceptance]
    })),
    acceptanceMap: Object.fromEntries(
      Object.entries(plan.acceptanceMap).map(([key, values]) => [key, [...values]])
    ),
    verificationChecklist: [...plan.verificationChecklist],
    risks: [...plan.risks]
  }
}

function cloneTaskState(task: XForgeTaskState): XForgeTaskState {
  return {
    ...task,
    acceptance: [...task.acceptance],
    evidenceRefs: task.evidenceRefs.map(e => ({ ...e }))
  }
}

function cloneWriteBoundary(boundary: XForgeWriteBoundary): XForgeWriteBoundary {
  return {
    ...boundary,
    fingerprint: { ...boundary.fingerprint }
  }
}

function cloneTestEvidence(evidence: XForgeTestEvidenceState): XForgeTestEvidenceState {
  return {
    ...evidence,
    fingerprint: { ...evidence.fingerprint },
    commands: evidence.commands.map(command => ({
      ...command,
      evidenceRef: { ...command.evidenceRef }
    }))
  }
}

function cloneReviewFinding(finding: XForgeReviewFindingState): XForgeReviewFindingState {
  return { ...finding }
}

function cloneReportFacts(facts: XForgeReportFactsState): XForgeReportFactsState {
  return {
    ...facts,
    testCommands: facts.testCommands.map(command => ({
      ...command,
      evidenceRef: { ...command.evidenceRef }
    })),
    completedTasks: [...facts.completedTasks],
    unverifiedTasks: [...(facts.unverifiedTasks ?? [])],
    skippedTasks: facts.skippedTasks.map(task => ({ ...task })),
    blockingFindings: facts.blockingFindings.map(cloneReviewFinding),
    technicalDebt: facts.technicalDebt.map(cloneReviewFinding),
    budgets: { ...facts.budgets },
    notExecuted: [...facts.notExecuted]
  }
}

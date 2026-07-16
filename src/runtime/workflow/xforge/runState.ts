/**
 * XForge Stage Run 在 RunCoordinator snapshot 中的权威状态切片。
 *
 * Renderer 只读投影；写入必须经 RunCoordinator 原子 commit。
 */

import { isTerminalStage } from './stageController'
import type {
  ScopePassRef,
  StageTransitionResult,
  XForgeStage
} from './types'
import type { XForgeValidatedPlan } from './plan'

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
  lastTransitionReason?: string
}

export interface CreateXForgeRunStateOptions {
  reviewOnly?: boolean
  /** 默认 resolve */
  currentStage?: XForgeStage
  planVersion?: number | null
  workspaceRevision?: number
  hasValidatedPlan?: boolean
  hasValidScopePass?: boolean
  scopePass?: ScopePassRef | null
  mainSession?: Partial<XForgeMainSessionState>
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
    reportFacts: null
  }
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
  /** waiting_user 时的恢复目标；缺省为转入前阶段 */
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
}

export type ApplyXForgeTransitionResult =
  | { ok: true; state: XForgeRunState }
  | {
      ok: false
      code: 'xforge_terminal' | 'transition_rejected' | 'from_mismatch'
      reason: string
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

  const next: XForgeRunState = {
    ...prev,
    currentStage: result.to,
    completedStages: [...(prev.completedStages ?? [])],
    skippedStages: [...(prev.skippedStages ?? [])],
    lastTransitionReason: result.reason,
    scopeCorrectionUsed:
      prev.scopeCorrectionUsed + (result.budgetDelta?.scopeCorrection ?? 0),
    deliveryTestFixUsed:
      prev.deliveryTestFixUsed + (result.budgetDelta?.deliveryTestFix ?? 0),
    reviewRemediationUsed:
      prev.reviewRemediationUsed + (result.budgetDelta?.reviewRemediation ?? 0),
    stageArtifacts: [...prev.stageArtifacts],
    evidenceRefs: [...prev.evidenceRefs],
    tasks: prev.tasks.map(cloneTaskState),
    validatedPlan: prev.validatedPlan ? cloneValidatedPlan(prev.validatedPlan) : null,
    mainSession: cloneMainSession(prev.mainSession ?? {
      goal: '',
      constraints: [],
      nonGoals: [],
      userDecisions: []
    }),
    pendingScopeFindings: (prev.pendingScopeFindings ?? []).map(finding => ({ ...finding })),
    activeTaskId: prev.activeTaskId,
    writeBoundary: prev.writeBoundary ? cloneWriteBoundary(prev.writeBoundary) : null,
    testEvidence: prev.testEvidence ? cloneTestEvidence(prev.testEvidence) : null,
    reviewFindings: (prev.reviewFindings ?? []).map(cloneReviewFinding),
    technicalDebt: (prev.technicalDebt ?? []).map(cloneReviewFinding),
    reportFacts: prev.reportFacts ? cloneReportFacts(prev.reportFacts) : null,
    scopePass: prev.scopePass ? { ...prev.scopePass } : null
  }

  if (opts.planVersion !== undefined) next.planVersion = opts.planVersion
  if (
    result.from !== 'waiting_user' &&
    result.to !== 'waiting_user' &&
    result.to !== 'failed' &&
    result.to !== 'cancelled' &&
    !next.completedStages.includes(result.from)
  ) {
    next.completedStages.push(result.from)
  }
  if (opts.completedStages !== undefined) next.completedStages = [...opts.completedStages]
  if (opts.skippedStages !== undefined) next.skippedStages = [...opts.skippedStages]
  if (opts.workspaceRevision !== undefined) next.workspaceRevision = opts.workspaceRevision
  if (opts.hasValidatedPlan !== undefined) next.hasValidatedPlan = opts.hasValidatedPlan
  if (opts.hasValidScopePass !== undefined) next.hasValidScopePass = opts.hasValidScopePass
  if (opts.scopePass !== undefined) {
    next.scopePass = opts.scopePass ? { ...opts.scopePass } : null
  }
  if (opts.reviewOnly !== undefined) next.reviewOnly = opts.reviewOnly

  if (opts.artifact) {
    next.stageArtifacts.push({ ...opts.artifact })
  }
  if (opts.evidenceRef) {
    next.evidenceRefs.push({ ...opts.evidenceRef })
  }
  if (opts.tasks !== undefined) {
    next.tasks = opts.tasks.map(cloneTaskState)
  }
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

  if (
    next.scopePass &&
    (next.scopePass.planVersion !== next.planVersion ||
      next.scopePass.workspaceRevision !== next.workspaceRevision)
  ) {
    next.hasValidScopePass = false
  }

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

  // Scope Gate 刚通过进入 implement：事实层同步签发 Pass
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
    reportFacts: state.reportFacts ? cloneReportFacts(state.reportFacts) : null
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

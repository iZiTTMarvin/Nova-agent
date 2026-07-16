import type { AskQuestionAnswer, AskQuestionItem } from '../../../shared/askQuestion/types'
import type { SkillManifest } from '../../skills/types'
import type {
  XForgeEvidenceRef,
  XForgeRunState,
  XForgeTaskState,
  XForgeWorkspaceFingerprint,
  XForgeWriteBoundary,
  XForgeMainSessionState,
  XForgeScopeFindingState,
  XForgeFileEffect,
  ApplyXForgeTransitionOptions
} from './runState'
import { validateXForgeCommittedEffects } from './writeSafety'
import {
  createTaskStatesFromPlan,
  validateXForgePlan,
  type XForgeValidatedPlan
} from './plan'
import {
  nextAfterScopeCheck,
  transition
} from './stageController'
import type {
  StageControllerContext,
  StageTransitionResult,
  XForgeStage,
  XForgeStartStage
} from './types'
import {
  resolveXForgeStageMethod,
  type XForgeStageMethodRegistry,
  type XForgeStageMethodResolution
} from './stageMethodResolver'

export type XForgeExplorationMethod = 'br-office-hours' | 'br-brainstorming'

export type XForgeScopeFinding = XForgeScopeFindingState

export interface XForgeScopeCheckResult {
  findings: XForgeScopeFinding[]
  evidenceRef: XForgeEvidenceRef
  artifact: NonNullable<ApplyXForgeTransitionOptions['artifact']>
}

export type XForgeTaskFileEffect = XForgeFileEffect

export interface XForgeTaskAttemptResult {
  verification: {
    outcome: 'passed' | 'failed' | 'blocked' | 'unverified'
    command: string | null
    exitCode: number | null
    timedOut: boolean
    blockedReason?: string
  }
  evidenceRef: XForgeEvidenceRef
  failureReason?: string
  fileEffects?: XForgeTaskFileEffect[]
  workspaceFingerprint?: XForgeWorkspaceFingerprint
}

export interface XForgeMainAgentContext {
  mainSession: XForgeMainSessionState
  planVersion: number | null
  validatedPlan: XForgeValidatedPlan | null
  stageArtifacts: XForgeRunState['stageArtifacts']
  evidenceRefs: XForgeRunState['evidenceRefs']
  scopeCorrectionUsed: number
}

export interface XForgeStageHost {
  activateStage: (params: {
    runId: string
    stage: XForgeStage
    method: string
    skill?: SkillManifest
  }) => void | Promise<void>
  askQuestion: (params: {
    runId: string
    stage: 'brainstorm'
    method: XForgeExplorationMethod
    questions: AskQuestionItem[]
  }) => Promise<AskQuestionAnswer[]>
  buildExplorationQuestions: (params: {
    runId: string
    method: XForgeExplorationMethod
    round: number
    context: XForgeMainAgentContext
  }) => Promise<AskQuestionItem[]>
  runBrainstorm: (params: {
    runId: string
    method: XForgeExplorationMethod
    round: number
    answers: AskQuestionAnswer[]
    context: XForgeMainAgentContext
  }) => Promise<{
    needsMoreClarification: boolean
    mainSession: XForgeMainSessionState
    artifact?: NonNullable<ApplyXForgeTransitionOptions['artifact']>
  }>
  runPlan: (params: {
    runId: string
    previousPlan?: XForgeValidatedPlan
    missing?: string[]
    scopeFindings?: XForgeScopeFinding[]
    nextPlanVersion: number
    context: XForgeMainAgentContext
  }) => Promise<{
    plan: XForgeValidatedPlan
    artifact: NonNullable<ApplyXForgeTransitionOptions['artifact']>
    workspaceRevision?: number
  }>
  runScopeCheck: (params: {
    runId: string
    plan: XForgeValidatedPlan
    context: XForgeMainAgentContext
  }) => Promise<XForgeScopeCheckResult>
  prepareWriteBoundary: (params: {
    runId: string
    checkpointRef: string
    workspaceRevision: number
  }) => Promise<XForgeWriteBoundary>
  runImplementTask: (params: {
    runId: string
    task: XForgeTaskState
    attempt: number
    writeBoundary: XForgeWriteBoundary
    context: XForgeMainAgentContext
  }) => Promise<XForgeTaskAttemptResult>
  completeImplement: (params: {
    runId: string
    tasks: XForgeTaskState[]
    writeBoundary: XForgeWriteBoundary
    context: XForgeMainAgentContext
  }) => Promise<{ artifact: NonNullable<ApplyXForgeTransitionOptions['artifact']> }>
}

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

export interface XForgeStageExecutorOptions {
  runId: string
  committer: XForgeRunCommitter
  host: XForgeStageHost
  methodRegistry: XForgeStageMethodRegistry
  startStage?: XForgeStartStage
  explorationContext?: {
    newProject?: boolean
    systemLevelChange?: boolean
  }
}

const IMPLEMENT_TASK_ATTEMPT_BUDGET = 3
const BRAINSTORM_CLARIFICATION_BUDGET = 3
const PAUSE_EXPLORATION_LABEL = '暂存本轮 XForge'

export class XForgeStageExecutor {
  private readonly runId: string
  private readonly committer: XForgeRunCommitter
  private readonly host: XForgeStageHost
  private readonly methodRegistry: XForgeStageMethodRegistry
  private readonly startStage: XForgeStartStage
  private readonly explorationMethod: XForgeExplorationMethod
  private currentPlan: XForgeValidatedPlan | null = null

  constructor(opts: XForgeStageExecutorOptions) {
    this.runId = opts.runId
    this.committer = opts.committer
    this.host = opts.host
    this.methodRegistry = opts.methodRegistry
    this.startStage = opts.startStage ?? 'brainstorm'
    this.explorationMethod =
      opts.explorationContext?.newProject || opts.explorationContext?.systemLevelChange
        ? 'br-office-hours'
        : 'br-brainstorming'
    this.currentPlan = this.committer.getSnapshot(this.runId)?.xforge?.validatedPlan ?? null
  }

  async runPreDeliveryStages(): Promise<XForgeRunState> {
    while (true) {
      const state = this.requireXForgeState()
      if (!isPreDeliveryStage(state.currentStage)) return state
      const method = resolveXForgeStageMethod(
        this.methodRegistry,
        state.currentStage,
        { explorationMethod: this.explorationMethod }
      )
      if (!method.ok) {
        return this.commitTransition({
          ok: true,
          from: state.currentStage,
          to: 'waiting_user',
          reason: method.reason
        })
      }
      await this.activateStage(state.currentStage, method)
      switch (state.currentStage) {
        case 'resolve':
          this.commitTransition(transition(toControllerContext(state), this.startStage))
          break
        case 'brainstorm':
          await this.runBrainstormStage()
          break
        case 'plan':
          await this.runPlanStage()
          break
        case 'scope_check':
          await this.runScopeStage()
          break
        case 'implement':
          await this.runImplementStage()
          break
      }
    }
  }

  private async activateStage(
    stage: XForgeStage,
    resolution: Extract<XForgeStageMethodResolution, { ok: true }>
  ): Promise<void> {
    await this.host.activateStage({
      runId: this.runId,
      stage,
      method: resolution.method,
      ...(resolution.skill ? { skill: resolution.skill } : {})
    })
  }

  private async runBrainstormStage(): Promise<void> {
    for (let round = 1; round <= BRAINSTORM_CLARIFICATION_BUDGET; round += 1) {
      const questions = appendExplorationPauseOption(await this.host.buildExplorationQuestions({
        runId: this.runId,
        method: this.explorationMethod,
        round,
        context: buildMainAgentContext(this.requireXForgeState())
      }))
      if (questions.length === 0) {
        this.waitForBrainstorm('探索阶段未能生成可回答的澄清问题')
        return
      }

      const answers = await this.host.askQuestion({
        runId: this.runId,
        stage: 'brainstorm',
        method: this.explorationMethod,
        questions
      })
      const decisionTexts = explorationDecisionTexts(answers)
      this.appendExplorationDecisions(decisionTexts)

      if (answers.length === 0 || answers.some(answer => answer.dismissed)) {
        this.waitForBrainstorm('探索阶段需要用户回答 askQuestion 后才能继续')
        return
      }
      if (decisionTexts.includes(PAUSE_EXPLORATION_LABEL)) {
        this.waitForBrainstorm('用户暂存了当前探索，等待补充约束后继续')
        return
      }

      const result = await this.host.runBrainstorm({
        runId: this.runId,
        method: this.explorationMethod,
        round,
        answers,
        context: buildMainAgentContext(this.requireXForgeState())
      })
      if (result.needsMoreClarification) {
        if (round === BRAINSTORM_CLARIFICATION_BUDGET) {
          this.waitForBrainstorm(`探索澄清已达到 ${BRAINSTORM_CLARIFICATION_BUDGET} 轮上限，仍缺少关键约束`)
          return
        }
        continue
      }

      const decisions = this.requireXForgeState().mainSession.userDecisions
      this.commitPatch({
        mainSession: {
          ...result.mainSession,
          constraints: [...result.mainSession.constraints],
          nonGoals: [...result.mainSession.nonGoals],
          userDecisions: mergeUniqueStrings(result.mainSession.userDecisions, decisions)
        }
      }, '记录探索阶段产物与用户决策')

      this.commitTransition(transition(toControllerContext(this.requireXForgeState()), 'plan'), {
        ...(result.artifact ? { artifact: result.artifact } : {})
      })
      return
    }
  }

  private appendExplorationDecisions(decisions: string[]): void {
    if (decisions.length === 0) return
    const state = this.requireXForgeState()
    this.commitPatch({
      mainSession: {
        ...state.mainSession,
        constraints: [...state.mainSession.constraints],
        nonGoals: [...state.mainSession.nonGoals],
        userDecisions: mergeUniqueStrings(state.mainSession.userDecisions, decisions)
      }
    }, '记录探索阶段用户决策')
  }

  private waitForBrainstorm(reason: string): void {
    this.commitTransition({
      ok: true,
      from: 'brainstorm',
      to: 'waiting_user',
      reason
    }, { resumeTarget: 'brainstorm' })
  }

  private async runPlanStage(missing?: string[]): Promise<void> {
    const stateBeforePlan = this.requireXForgeState()
    const nextPlanVersion = (stateBeforePlan.planVersion ?? 0) + 1
    const result = await this.host.runPlan({
      runId: this.runId,
      ...(this.currentPlan ? { previousPlan: this.currentPlan } : {}),
      ...(missing ? { missing } : {}),
      ...(stateBeforePlan.pendingScopeFindings.length > 0
        ? { scopeFindings: stateBeforePlan.pendingScopeFindings.map(finding => ({ ...finding })) }
        : {}),
      nextPlanVersion,
      context: buildMainAgentContext(stateBeforePlan)
    })
    const authoritativePlan = { ...result.plan, version: nextPlanVersion }
    const validation = validateXForgePlan(authoritativePlan)

    if (!validation.valid) {
      this.commitTransition({
        ok: true,
        from: 'plan',
        to: 'waiting_user',
        reason: `Validated Plan 缺少必需字段: ${validation.missing.join(', ')}`
      }, {
        artifact: result.artifact
      })
      return
    }

    this.currentPlan = authoritativePlan
    const tasks = createTaskStatesFromPlan(authoritativePlan)
    const revision = result.workspaceRevision ?? this.requireXForgeState().workspaceRevision

    this.commitTransition(transition(toControllerContext(this.requireXForgeState()), 'scope_check'), {
      hasValidatedPlan: true,
      hasValidScopePass: false,
      scopePass: null,
      planVersion: authoritativePlan.version,
      validatedPlan: authoritativePlan,
      mainSession: mainSessionFromPlan(stateBeforePlan.mainSession, authoritativePlan),
      pendingScopeFindings: [],
      workspaceRevision: revision,
      tasks,
      activeTaskId: null,
      artifact: result.artifact
    })
  }

  private async runScopeStage(): Promise<void> {
    const plan = this.currentPlan
    if (!plan) {
      this.commitTransition({
        ok: true,
        from: 'scope_check',
        to: 'waiting_user',
        reason: 'Scope Check 缺少当前 Validated Plan'
      })
      return
    }

    const result = await this.host.runScopeCheck({
      runId: this.runId,
      plan,
      context: buildMainAgentContext(this.requireXForgeState())
    })
    const hasHigh = result.findings.some(
      finding => finding.severity === 'critical' || finding.severity === 'high'
    )
    const transitionResult = nextAfterScopeCheck(toControllerContext(this.requireXForgeState()), hasHigh)
    const committed = this.commitTransition(transitionResult, {
      ...(transitionResult.ok && transitionResult.to === 'waiting_user'
        ? { resumeTarget: 'plan' as const }
        : {}),
      pendingScopeFindings: hasHigh
        ? result.findings
            .filter(finding => finding.severity === 'critical' || finding.severity === 'high')
            .map(finding => ({ ...finding }))
        : [],
      evidenceRef: result.evidenceRef,
      artifact: result.artifact
    })

    if (committed.currentStage === 'plan' && hasHigh) {
      await this.runPlanStage(['scope_check.high'])
    }
  }

  private async runImplementStage(): Promise<void> {
    let state = this.requireXForgeState()
    if (state.tasks.length === 0) {
      this.commitTransition({
        ok: true,
        from: 'implement',
        to: 'waiting_user',
        reason: 'implement 阶段缺少 Validated Plan 任务列表'
      })
      return
    }

    let boundary = state.writeBoundary
    if (!boundary) {
      boundary = await this.host.prepareWriteBoundary({
        runId: this.runId,
        checkpointRef: `xforge:${this.runId}:implement`,
        workspaceRevision: state.workspaceRevision
      })
      const boundaryFailure = validateWriteBoundary(boundary, state.workspaceRevision)
      if (boundaryFailure) {
        this.commitTransition({
          ok: true,
          from: 'implement',
          to: 'waiting_user',
          reason: boundaryFailure
        })
        return
      }
      state = this.commitPatch({ writeBoundary: boundary }, 'implement 写入边界已准备')
    }

    let tasks = state.tasks.map(cloneTask)
    for (const task of tasks) {
      if (task.status === 'done' || task.status === 'unverified' || task.status === 'skipped') continue

      let current = { ...task, evidenceRefs: task.evidenceRefs.map(e => ({ ...e })) }
      while (current.attempts < IMPLEMENT_TASK_ATTEMPT_BUDGET && current.status !== 'done') {
        current = {
          ...current,
          status: 'in_progress',
          attempts: current.attempts + 1
        }
        tasks = replaceTask(tasks, current)
        this.commitPatch({ tasks, activeTaskId: current.id }, `开始任务 ${current.id} 第 ${current.attempts} 次尝试`)

        const attempt = await this.host.runImplementTask({
          runId: this.runId,
          task: current,
          attempt: current.attempts,
          writeBoundary: boundary,
          context: buildMainAgentContext(this.requireXForgeState())
        })
        const effectSafetyFailure = validateXForgeCommittedEffects({
          effects: attempt.fileEffects,
          workspaceFingerprint: attempt.workspaceFingerprint,
          currentWorkspaceRevision: this.requireXForgeState().workspaceRevision
        })
        if (effectSafetyFailure) {
          tasks = replaceTask(tasks, {
            ...current,
            status: 'failed',
            failureReason: effectSafetyFailure
          })
          this.commitPatch({ tasks, activeTaskId: null }, `任务 ${current.id} 存在未决副作用`)
          this.commitTransition({
            ok: true,
            from: 'implement',
            to: 'waiting_user',
            reason: `Pending Side Effect 阻止自动推进: ${effectSafetyFailure}`
          })
          return
        }
        const hasWrites = (attempt.fileEffects?.length ?? 0) > 0
        const passed = attempt.verification.outcome === 'passed'
        const evidenceRefs = [
          ...current.evidenceRefs,
          ...(attempt.evidenceRef ? [attempt.evidenceRef] : [])
        ]

        if (attempt.verification.outcome === 'blocked') {
          const reason = attempt.verification.blockedReason ?? '任务验证环境阻塞'
          tasks = replaceTask(tasks, {
            ...current,
            status: 'failed',
            evidenceRefs,
            failureReason: reason
          })
          this.commitPatch({ tasks, activeTaskId: null }, `任务 ${current.id} 验证环境阻塞`)
          this.commitTransition({
            ok: true,
            from: 'implement',
            to: 'waiting_user',
            reason: `任务验证无法执行: ${reason}`
          })
          return
        }

        if (attempt.verification.outcome === 'unverified') {
          // 缺少定向命令不是实施失败，不能占用三次验收重试预算。
          current = {
            ...current,
            status: 'unverified',
            attempts: Math.max(0, current.attempts - 1),
            evidenceRefs
          }
        } else if (passed) {
          current = { ...current, status: 'done', evidenceRefs }
        } else if (current.attempts >= IMPLEMENT_TASK_ATTEMPT_BUDGET) {
          current = {
            ...current,
            status: 'skipped',
            evidenceRefs,
            failureReason:
              attempt.failureReason ??
              formatVerificationFailure(attempt.verification) ??
              `任务连续 ${IMPLEMENT_TASK_ATTEMPT_BUDGET} 次验收失败`
          }
        } else {
          current = {
            ...current,
            status: 'in_progress',
            evidenceRefs,
            failureReason:
              attempt.failureReason ??
              formatVerificationFailure(attempt.verification) ?? undefined
          }
        }

        tasks = replaceTask(tasks, current)
        const latestState = this.requireXForgeState()
        this.commitPatch({
          tasks,
          activeTaskId: current.status === 'done' || current.status === 'unverified' || current.status === 'skipped'
            ? null
            : current.id,
          ...(hasWrites && attempt.workspaceFingerprint
            ? {
                workspaceRevision: latestState.workspaceRevision + 1,
                hasValidScopePass: false,
                writeBoundary: {
                  ...boundary,
                  fingerprint: attempt.workspaceFingerprint
                }
              }
            : {})
        }, `更新任务 ${current.id} 状态`)
        if (hasWrites && attempt.workspaceFingerprint) {
          boundary = {
            ...boundary,
            fingerprint: attempt.workspaceFingerprint
          }
        }
        if (current.status === 'unverified') break
      }
    }

    this.commitPatch({ activeTaskId: null }, 'implement 任务子循环完成')
    const completed = await this.host.completeImplement({
      runId: this.runId,
      tasks: tasks.map(cloneTask),
      writeBoundary: boundary,
      context: buildMainAgentContext(this.requireXForgeState())
    })
    this.commitTransition(transition(toControllerContext(this.requireXForgeState()), 'test'), {
      artifact: completed.artifact
    })
  }

  private requireXForgeState(): XForgeRunState {
    const snapshot = this.committer.getSnapshot(this.runId)
    if (!snapshot?.xforge) {
      throw new Error(`XForge run 不存在或缺少状态: ${this.runId}`)
    }
    return snapshot.xforge
  }

  private commitTransition(
    result: StageTransitionResult,
    opts: ApplyXForgeTransitionOptions = {}
  ): XForgeRunState {
    const committed = this.committer.commitXForgeStageTransition(this.runId, result, opts)
    if (!committed.ok) throw new Error(committed.message)
    return committed.xforge
  }

  private commitPatch(opts: ApplyXForgeTransitionOptions, reason: string): XForgeRunState {
    const committed = this.committer.commitXForgeStatePatch(this.runId, opts, reason)
    if (!committed.ok) throw new Error(committed.message)
    return committed.xforge
  }
}

function isPreDeliveryStage(stage: XForgeStage): stage is 'resolve' | 'brainstorm' | 'plan' | 'scope_check' | 'implement' {
  return stage === 'resolve' ||
    stage === 'brainstorm' ||
    stage === 'plan' ||
    stage === 'scope_check' ||
    stage === 'implement'
}

function mainSessionFromPlan(
  previous: XForgeMainSessionState,
  plan: XForgeValidatedPlan
): XForgeMainSessionState {
  return {
    goal: plan.goal,
    constraints: [...plan.constraints],
    nonGoals: [...plan.nonGoals],
    userDecisions: [...previous.userDecisions]
  }
}

export function toControllerContext(state: XForgeRunState): StageControllerContext {
  return {
    currentStage: state.currentStage,
    reviewOnly: state.reviewOnly,
    hasValidatedPlan: state.hasValidatedPlan,
    hasValidScopePass: state.hasValidScopePass,
    scopeCorrectionUsed: state.scopeCorrectionUsed,
    deliveryTestFixUsed: state.deliveryTestFixUsed,
    reviewRemediationUsed: state.reviewRemediationUsed
  }
}

export function buildWriteBoundary(params: {
  checkpointRef: string
  fingerprint: XForgeWorkspaceFingerprint
}): XForgeWriteBoundary {
  return {
    checkpointRef: params.checkpointRef,
    fingerprint: params.fingerprint,
    preparedAt: Date.now()
  }
}

export function buildMainAgentContext(state: XForgeRunState): XForgeMainAgentContext {
  return {
    mainSession: {
      goal: state.mainSession.goal,
      constraints: [...state.mainSession.constraints],
      nonGoals: [...state.mainSession.nonGoals],
      userDecisions: [...state.mainSession.userDecisions]
    },
    planVersion: state.planVersion,
    validatedPlan: state.validatedPlan ? structuredClone(state.validatedPlan) : null,
    stageArtifacts: state.stageArtifacts.map(artifact => ({ ...artifact })),
    evidenceRefs: state.evidenceRefs.map(evidence => ({ ...evidence })),
    scopeCorrectionUsed: state.scopeCorrectionUsed
  }
}

function appendExplorationPauseOption(questions: AskQuestionItem[]): AskQuestionItem[] {
  return questions.slice(0, 3).map((question, index) => ({
    ...question,
    options: [
      ...question.options,
      ...(index === 0 && !question.options.some(option => option.label === PAUSE_EXPLORATION_LABEL)
        ? [{ label: PAUSE_EXPLORATION_LABEL, description: '保留当前已收集信息，稍后补充约束后继续。' }]
        : [])
    ]
  }))
}

function explorationDecisionTexts(answers: AskQuestionAnswer[]): string[] {
  return answers.flatMap(answer => [
    ...(answer.selectedLabels ?? []),
    ...(answer.customInput ? [answer.customInput] : [])
  ])
}

function mergeUniqueStrings(...groups: string[][]): string[] {
  return [...new Set(groups.flatMap(group => group.filter(Boolean)))]
}

function replaceTask(tasks: XForgeTaskState[], next: XForgeTaskState): XForgeTaskState[] {
  return tasks.map(task => (task.id === next.id ? cloneTask(next) : cloneTask(task)))
}

function cloneTask(task: XForgeTaskState): XForgeTaskState {
  return {
    ...task,
    acceptance: [...task.acceptance],
    evidenceRefs: task.evidenceRefs.map(e => ({ ...e }))
  }
}

function validateWriteBoundary(
  boundary: XForgeWriteBoundary,
  workspaceRevision: number
): string | null {
  if (!boundary.checkpointRef.trim()) return '写入前缺少完整 Checkpoint 引用'
  if (!boundary.fingerprint.digest.trim()) return '写入前缺少 Workspace Fingerprint'
  if (boundary.fingerprint.revision !== workspaceRevision) {
    return `Workspace Fingerprint 版本 ${boundary.fingerprint.revision} 与权威版本 ${workspaceRevision} 不一致`
  }
  return null
}

function formatVerificationFailure(
  verification: XForgeTaskAttemptResult['verification']
): string | null {
  if (verification.outcome === 'unverified') return null
  if (verification.blockedReason) return verification.blockedReason
  if (verification.timedOut) return `任务验证超时: ${verification.command ?? 'unknown'}`
  if (verification.exitCode !== 0) {
    return `任务验证失败（exitCode=${verification.exitCode ?? 'unknown'}）: ${verification.command ?? 'unknown'}`
  }
  return null
}

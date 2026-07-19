import type { SkillManifest } from '../../skills/types'
import {
  nextAfterFix,
  nextAfterReview,
  nextAfterTest,
  transition
} from './stageController'
import {
  resolveXForgeStageMethod,
  type XForgeStageMethodRegistry,
  type XForgeStageMethodResolution
} from './stageMethodResolver'
import { buildWriteBoundary, toControllerContext } from './stageExecutor'
import { validateXForgeCommittedEffects } from './writeSafety'
import { authorizeXForgeVerificationCommand } from './policy'
import type { XForgeReviewWorkspaceSnapshot } from './reviewSnapshot'
export {
  isForbiddenXForgeSideEffectCommand,
  isSafeRuntimeTestCommand
} from './policy'
import type {
  ApplyXForgeTransitionOptions,
  XForgeControlledCommandEvidence,
  XForgeEvidenceRef,
  XForgeFileEffect,
  XForgeReportFactsState,
  XForgeReviewFindingState,
  XForgeRunState,
  XForgeRunCommitter,
  XForgeStageArtifactRef,
  XForgeTestEvidenceState,
  XForgeWorkspaceFingerprint,
  XForgeWriteBoundary
} from './runState'
import type { XForgeStage } from './types'

export interface XForgeControlledTestCommand {
  command: string
  required: boolean
  reason: string
  timeoutMs?: number
}

export interface XForgeRuntimeCommandResult {
  exitCode: number | null
  timedOut: boolean
  blockedReason?: string
  evidenceRef: XForgeEvidenceRef
}

export interface XForgeReviewInputSnapshot {
  runId: string
  workspaceRevision: number
  fingerprint: XForgeWorkspaceFingerprint
  plan: XForgeRunState['validatedPlan']
  tasks: XForgeRunState['tasks']
  testEvidence: XForgeTestEvidenceState | null
  reviewOnly: boolean
  workspace: XForgeReviewWorkspaceSnapshot
}

export interface XForgeFixResult {
  expandsScope: boolean
  fileEffects?: XForgeFileEffect[]
  workspaceFingerprint?: XForgeWorkspaceFingerprint
  artifact: XForgeStageArtifactRef
  evidenceRef?: XForgeEvidenceRef
}

export interface XForgeDeliveryHost {
  activateStage: (params: {
    runId: string
    stage: 'test' | 'review' | 'fix' | 'report'
    method: string
    skill?: SkillManifest
  }) => void | Promise<void>
  captureWorkspaceFingerprint: (params: {
    runId: string
    workspaceRevision: number
  }) => Promise<XForgeWorkspaceFingerprint>
  resolveControlledTestCommands: (params: {
    runId: string
    state: XForgeRunState
  }) => Promise<{
    commands: XForgeControlledTestCommand[]
    blockedReason?: string
  }>
  runControlledCommand: (params: {
    runId: string
    command: XForgeControlledTestCommand
  }) => Promise<XForgeRuntimeCommandResult>
  recordTestEvidence: (params: {
    runId: string
    evidence: XForgeTestEvidenceState
  }) => Promise<{ artifact: XForgeStageArtifactRef; evidenceRef: XForgeEvidenceRef }>
  createReviewSnapshot: (params: {
    runId: string
    workspaceRevision: number
    fingerprint: XForgeWorkspaceFingerprint
    state: XForgeRunState
  }) => Promise<{
    snapshot?: XForgeReviewWorkspaceSnapshot
    blockedReason?: string
  }>
  runReviewSubagent: (params: {
    input: Readonly<XForgeReviewInputSnapshot>
  }) => Promise<{
    findings: XForgeReviewFindingState[]
    artifact: XForgeStageArtifactRef
    evidenceRef: XForgeEvidenceRef
  }>
  prepareWriteBoundary: (params: {
    runId: string
    checkpointRef: string
    workspaceRevision: number
  }) => Promise<XForgeWriteBoundary>
  runFix: (params: {
    runId: string
    state: XForgeRunState
    writeBoundary: XForgeWriteBoundary
    failedTest: XForgeTestEvidenceState | null
    blockingFindings: XForgeReviewFindingState[]
  }) => Promise<XForgeFixResult>
  askShipIntent?: (params: {
    runId: string
    facts: XForgeReportFactsState
  }) => Promise<boolean>
  writeReport: (params: {
    runId: string
    facts: XForgeReportFactsState
  }) => Promise<{ artifact: XForgeStageArtifactRef }>
}

export interface XForgeDeliveryExecutorOptions {
  runId: string
  committer: XForgeRunCommitter
  host: XForgeDeliveryHost
  methodRegistry: XForgeStageMethodRegistry
}

const DELIVERY_STAGES = new Set<XForgeStage>(['test', 'review', 'fix', 'report'])

export class XForgeDeliveryExecutor {
  private readonly runId: string
  private readonly committer: XForgeRunCommitter
  private readonly host: XForgeDeliveryHost
  private readonly methodRegistry: XForgeStageMethodRegistry

  constructor(opts: XForgeDeliveryExecutorOptions) {
    this.runId = opts.runId
    this.committer = opts.committer
    this.host = opts.host
    this.methodRegistry = opts.methodRegistry
  }

  async runDeliveryStages(): Promise<XForgeRunState> {
    while (true) {
      const state = this.requireState()
      if (!DELIVERY_STAGES.has(state.currentStage)) return state

      const resolution = resolveXForgeStageMethod(this.methodRegistry, state.currentStage)
      if (!resolution.ok) return this.wait(state.currentStage, resolution.reason)
      await this.activateStage(state.currentStage, resolution)

      switch (state.currentStage) {
        case 'test':
          await this.runTestStage()
          break
        case 'review':
          await this.runReviewStage()
          break
        case 'fix':
          await this.runFixStage()
          break
        case 'report':
          await this.runReportStage()
          break
      }
    }
  }

  private async activateStage(
    stage: XForgeStage,
    resolution: Extract<XForgeStageMethodResolution, { ok: true }>
  ): Promise<void> {
    if (stage !== 'test' && stage !== 'review' && stage !== 'fix' && stage !== 'report') return
    await this.host.activateStage({
      runId: this.runId,
      stage,
      method: resolution.method,
      ...(resolution.skill ? { skill: resolution.skill } : {})
    })
  }

  private async runTestStage(): Promise<void> {
    const state = this.requireState()
    const before = await this.captureFingerprint(state.workspaceRevision)
    const drift = compareAuthoritativeFingerprint(state, before)
    if (drift) {
      this.wait('test', drift)
      return
    }

    const testPlan = await this.host.resolveControlledTestCommands({
      runId: this.runId,
      state: structuredClone(state)
    })
    if (testPlan.blockedReason) {
      this.wait('test', `Test Gate 无法执行: ${testPlan.blockedReason}`)
      return
    }
    const commands = normalizeCommands(testPlan.commands)
    if (commands.length === 0 || !commands.some(command => command.required)) {
      this.wait('test', 'Test Gate 缺少至少一项针对改动行为的必需验证命令')
      return
    }
    const unsafeCommand = commands.find(command => !authorizeXForgeVerificationCommand(command.command).allowed)
    if (unsafeCommand) {
      this.wait('test', `Test Gate 拒绝非验证或高风险命令: ${unsafeCommand.command}`)
      return
    }

    const commandEvidence: XForgeControlledCommandEvidence[] = []
    for (const command of commands) {
      const result = await this.host.runControlledCommand({ runId: this.runId, command })
      const evidence: XForgeControlledCommandEvidence = {
        command: command.command,
        required: command.required,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        ...(result.blockedReason ? { blockedReason: result.blockedReason } : {}),
        evidenceRef: { ...result.evidenceRef }
      }
      commandEvidence.push(evidence)
      if (result.blockedReason) {
        this.wait('test', `Test Gate 环境阻塞: ${result.blockedReason}`, {
          evidenceRef: result.evidenceRef
        })
        return
      }
    }

    const after = await this.captureFingerprint(state.workspaceRevision)
    if (before.digest !== after.digest) {
      this.wait('test', 'Test Gate 执行期间工作区发生变化，证据已失效')
      return
    }

    const passed = commandEvidence.every(command =>
      !command.required || (command.exitCode === 0 && !command.timedOut && !command.blockedReason)
    )
    const evidence: XForgeTestEvidenceState = {
      workspaceRevision: state.workspaceRevision,
      fingerprint: after,
      commands: commandEvidence,
      passed,
      capturedAt: Date.now()
    }
    const recorded = await this.host.recordTestEvidence({ runId: this.runId, evidence })
    this.commitTransition(nextAfterTest(toControllerContext(state), passed), {
      testEvidence: evidence,
      artifact: recorded.artifact,
      evidenceRef: recorded.evidenceRef
    })
  }

  private async runReviewStage(): Promise<void> {
    const state = this.requireState()
    const currentFingerprint = await this.captureFingerprint(state.workspaceRevision)
    const freshTest = isFreshPassingTestEvidence(state.testEvidence, currentFingerprint)
    if (!state.reviewOnly && !freshTest) {
      this.wait('review', 'Review 前缺少绑定当前 Workspace Revision/Fingerprint 的通过测试证据', {
        resumeTarget: 'test'
      })
      return
    }

    const workspaceResult = await this.host.createReviewSnapshot({
      runId: this.runId,
      workspaceRevision: state.workspaceRevision,
      fingerprint: currentFingerprint,
      state: structuredClone(state)
    })
    if (workspaceResult.blockedReason || !workspaceResult.snapshot) {
      this.wait('review', `Review Input Snapshot 无法生成: ${workspaceResult.blockedReason ?? '缺少快照'}`)
      return
    }
    const input = freezeReviewInput({
      runId: this.runId,
      workspaceRevision: state.workspaceRevision,
      fingerprint: currentFingerprint,
      plan: state.validatedPlan ? structuredClone(state.validatedPlan) : null,
      tasks: structuredClone(state.tasks),
      testEvidence: freshTest && state.testEvidence ? structuredClone(state.testEvidence) : null,
      reviewOnly: state.reviewOnly,
      workspace: structuredClone(workspaceResult.snapshot)
    })
    const result = await this.host.runReviewSubagent({ input })
    const afterReview = await this.captureFingerprint(state.workspaceRevision)
    if (afterReview.digest !== currentFingerprint.digest) {
      this.wait('review', 'Review 子代理执行期间工作区发生变化，违反只读隔离边界')
      return
    }
    const validationFailure = validateReviewFindings(result.findings)
    if (validationFailure) {
      this.wait('review', validationFailure)
      return
    }

    const findings = result.findings.map(finding => ({
      ...finding,
      ...(state.reviewOnly && !freshTest ? { unverified: true } : {})
    }))
    const blocking = findings.filter(isBlockingFinding)
    const technicalDebt = findings.filter(finding => !isBlockingFinding(finding))
    this.commitTransition(nextAfterReview(toControllerContext(state), blocking.length > 0), {
      reviewFindings: findings,
      technicalDebt,
      artifact: result.artifact,
      evidenceRef: result.evidenceRef
    })
  }

  private async runFixStage(): Promise<void> {
    let state = this.requireState()
    if (state.reviewOnly) {
      this.wait('fix', 'reviewOnly 禁止进入修复阶段')
      return
    }

    let boundary = state.writeBoundary
    if (!boundary) {
      boundary = await this.host.prepareWriteBoundary({
        runId: this.runId,
        checkpointRef: `xforge:${this.runId}:fix`,
        workspaceRevision: state.workspaceRevision
      })
      const boundaryFailure = validateBoundary(boundary, state.workspaceRevision)
      if (boundaryFailure) {
        this.wait('fix', boundaryFailure)
        return
      }
      state = this.commitPatch({ writeBoundary: boundary }, 'fix 写入边界已准备')
    }

    const result = await this.host.runFix({
      runId: this.runId,
      state: structuredClone(state),
      writeBoundary: structuredClone(boundary),
      failedTest: state.testEvidence?.passed === false ? structuredClone(state.testEvidence) : null,
      blockingFindings: state.reviewFindings.filter(isBlockingFinding).map(finding => ({ ...finding }))
    })
    const effectFailure = validateXForgeCommittedEffects({
      effects: result.fileEffects,
      workspaceFingerprint: result.workspaceFingerprint,
      currentWorkspaceRevision: state.workspaceRevision
    })
    if (effectFailure) {
      this.wait('fix', `Pending Side Effect 阻止自动推进: ${effectFailure}`)
      return
    }

    const hasWrites = (result.fileEffects?.length ?? 0) > 0
    const observedFingerprint = await this.captureFingerprint(
      state.workspaceRevision + (hasWrites ? 1 : 0)
    )
    if (!hasWrites && observedFingerprint.digest !== boundary.fingerprint.digest) {
      this.wait('fix', 'Fix 检测到未登记 EffectReceipt 的工作区写入')
      return
    }
    if (
      hasWrites &&
      result.workspaceFingerprint &&
      observedFingerprint.digest !== result.workspaceFingerprint.digest
    ) {
      this.wait('fix', 'Fix 写后 Fingerprint 与 Runtime 实际工作区不一致')
      return
    }

    const transitionOptions: ApplyXForgeTransitionOptions = {
      artifact: result.artifact,
      ...(result.evidenceRef ? { evidenceRef: result.evidenceRef } : {}),
      testEvidence: null,
      ...(hasWrites && result.workspaceFingerprint
        ? {
            workspaceRevision: state.workspaceRevision + 1,
            hasValidScopePass: false,
            writeBoundary: buildWriteBoundary({
              checkpointRef: boundary.checkpointRef,
              fingerprint: result.workspaceFingerprint
            })
          }
        : {}),
      ...(result.expandsScope
        ? {
            hasValidatedPlan: false,
            hasValidScopePass: false,
            scopePass: null
          }
        : {})
    }
    this.commitTransition(nextAfterFix(toControllerContext(state), result.expandsScope), transitionOptions)
  }

  private async runReportStage(): Promise<void> {
    const state = this.requireState()
    const baseFacts = buildReportFacts(this.runId, state, false)
    const shipRequested = this.host.askShipIntent
      ? await this.host.askShipIntent({ runId: this.runId, facts: structuredClone(baseFacts) })
      : false
    const facts = buildReportFacts(this.runId, state, shipRequested)
    const report = await this.host.writeReport({
      runId: this.runId,
      facts: structuredClone(facts)
    })
    this.commitTransition(transition(toControllerContext(state), 'completed'), {
      reportFacts: facts,
      artifact: report.artifact
    })
  }

  private async captureFingerprint(revision: number): Promise<XForgeWorkspaceFingerprint> {
    const fingerprint = await this.host.captureWorkspaceFingerprint({
      runId: this.runId,
      workspaceRevision: revision
    })
    if (fingerprint.revision !== revision || !fingerprint.digest.trim()) {
      throw new Error(`Runtime 返回了无效 Workspace Fingerprint（revision=${fingerprint.revision}）`)
    }
    return fingerprint
  }

  private requireState(): XForgeRunState {
    const state = this.committer.getSnapshot(this.runId)?.xforge
    if (!state) throw new Error(`XForge run 不存在或缺少状态: ${this.runId}`)
    return state
  }

  private wait(
    from: XForgeStage,
    reason: string,
    opts: ApplyXForgeTransitionOptions = {}
  ): XForgeRunState {
    return this.commitTransition({ ok: true, from, to: 'waiting_user', reason }, opts)
  }

  private commitTransition(
    result: Parameters<XForgeRunCommitter['commitXForgeStageTransition']>[1],
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

function normalizeCommands(commands: XForgeControlledTestCommand[]): XForgeControlledTestCommand[] {
  const seen = new Set<string>()
  const normalized: XForgeControlledTestCommand[] = []
  for (const command of commands) {
    const text = command.command.trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    normalized.push({ ...command, command: text })
  }
  return normalized
}

function compareAuthoritativeFingerprint(
  state: XForgeRunState,
  current: XForgeWorkspaceFingerprint
): string | null {
  const authoritative = state.writeBoundary?.fingerprint
  if (!authoritative || authoritative.revision !== state.workspaceRevision) return null
  return authoritative.digest === current.digest
    ? null
    : 'Workspace Drift：当前内容与写入边界 Fingerprint 不一致'
}

function isFreshPassingTestEvidence(
  evidence: XForgeTestEvidenceState | null,
  current: XForgeWorkspaceFingerprint
): boolean {
  return Boolean(
    evidence?.passed &&
    evidence.workspaceRevision === current.revision &&
    evidence.fingerprint.revision === current.revision &&
    evidence.fingerprint.digest === current.digest
  )
}

function validateReviewFindings(findings: XForgeReviewFindingState[]): string | null {
  if (!Array.isArray(findings)) return 'Review 子代理返回格式无效'
  for (const finding of findings) {
    if (!finding.location?.trim() || !finding.summary?.trim() || !finding.evidence?.trim()) {
      return 'Review Finding 缺少 location、summary 或 evidence'
    }
    if (!['critical', 'high', 'medium', 'low', 'nit'].includes(finding.severity)) {
      return `Review Finding severity 无效: ${String(finding.severity)}`
    }
  }
  return null
}

function isBlockingFinding(finding: XForgeReviewFindingState): boolean {
  return finding.severity === 'critical' || finding.severity === 'high'
}

function validateBoundary(boundary: XForgeWriteBoundary, revision: number): string | null {
  if (!boundary.checkpointRef.trim()) return 'fix 写入前缺少完整 Checkpoint 引用'
  if (!boundary.fingerprint.digest.trim()) return 'fix 写入前缺少 Workspace Fingerprint'
  if (boundary.fingerprint.revision !== revision) {
    return `fix Fingerprint 版本 ${boundary.fingerprint.revision} 与权威版本 ${revision} 不一致`
  }
  return null
}

function freezeReviewInput(input: XForgeReviewInputSnapshot): Readonly<XForgeReviewInputSnapshot> {
  return deepFreeze(input)
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child)
  }
  return Object.freeze(value)
}

export function buildReportFacts(
  runId: string,
  state: XForgeRunState,
  shipRequested: boolean
): XForgeReportFactsState {
  return {
    runId,
    finalWorkspaceRevision: state.workspaceRevision,
    testPassed: state.testEvidence?.passed === true,
    testCommands: state.testEvidence?.commands.map(command => ({
      ...command,
      evidenceRef: { ...command.evidenceRef }
    })) ?? [],
    completedTasks: state.tasks.filter(task => task.status === 'done').map(task => task.id),
    unverifiedTasks: state.tasks.filter(task => task.status === 'unverified').map(task => task.id),
    skippedTasks: state.tasks
      .filter(task => task.status === 'skipped')
      .map(task => ({ id: task.id, reason: task.failureReason ?? '未提供原因' })),
    blockingFindings: state.reviewFindings.filter(isBlockingFinding).map(finding => ({ ...finding })),
    technicalDebt: state.technicalDebt.map(finding => ({ ...finding })),
    budgets: {
      scopeCorrectionUsed: state.scopeCorrectionUsed,
      deliveryTestFixUsed: state.deliveryTestFixUsed,
      reviewRemediationUsed: state.reviewRemediationUsed
    },
    shipRequested,
    notExecuted: ['commit', 'push', 'deploy', 'publish']
  }
}

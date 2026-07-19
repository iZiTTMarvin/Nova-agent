import type { AskQuestionAnswer, AskQuestionItem } from '../../../shared/askQuestion/types'
import type { ModelClient } from '../../model/ModelClient'
import type { ModelClientPool } from '../../model/ModelClientPool'
import type { EventBus } from '../../agent/EventBus'
import type { CheckpointManager } from '../../checkpoints/CheckpointManager'
import type { ToolRegistry } from '../../tools/ToolRegistry'
import type { SkillRegistry } from '../../skills/SkillRegistry'
import type { ReadState } from '../../tools/editTool'
import { XForgeDeliveryExecutor } from './deliveryExecutor'
import {
  captureXForgeWorkspaceBaseline,
  resolveXForgeReviewTarget
} from './workspaceBaseline'
import { XForgeExecutionPipeline } from './executionPipeline'
import { XForgeFileEffectRecorder } from './effectRecorder'
import { XForgeMainAgentSession } from './mainAgentSession'
import {
  createXForgeLiveDeliveryHost,
  resolveXForgeTaskVerificationCommand
} from './liveDeliveryHost'
import type { XForgeLiveHostRuntime } from './liveHostRuntime'
import {
  createXForgeLiveStageHost,
  renderPlanArtifact
} from './liveStageHost'
import {
  classifyXForgeRequest,
  importReferencedValidatedPlan,
  resolveXForgeRequestSignals,
  stripFullDevCommand
} from './requestResolution'
import { resolveStartStage } from './stageResolver'
import { XForgeStageExecutor } from './stageExecutor'
import { writeXForgeArtifact } from './stageArtifacts'
import type { XForgeRunState, XForgeRunCommitter } from './runState'
import type { XForgeStartStage } from './types'
import { createTaskStatesFromPlan } from './plan'

export interface XForgeLiveRuntimeOptions {
  runId: string
  request: string
  explicitFullDev?: boolean
  workspaceRoot: string
  modelClient: ModelClient | ModelClientPool
  parentEventBus: EventBus
  parentMessageId: string
  toolRegistry: ToolRegistry
  skillRegistry: SkillRegistry
  checkpointManager: CheckpointManager
  committer: XForgeRunCommitter
  askQuestion: (requestId: string, questions: AskQuestionItem[]) => Promise<AskQuestionAnswer[]>
  abortSignal?: AbortSignal
  assertExecutionCurrent?: () => boolean
  contextWindow?: number
  supportsVision?: boolean
  readState?: ReadState
  /** 仅新建且尚未发生业务写入的 run 可以初始化 baseline。 */
  initializeWorkspaceBaseline: boolean
}

export interface XForgeLiveRuntimeResult {
  state: XForgeRunState
  summary: string
}

/** 产品入口：装配 session/hosts/pipeline 并负责生命周期收尾。 */
export async function runXForgeLiveRuntime(
  options: XForgeLiveRuntimeOptions
): Promise<XForgeLiveRuntimeResult> {
  const runtime: XForgeLiveHostRuntime = {
    activeStage: options.committer.getSnapshot(options.runId)?.xforge?.currentStage ?? 'resolve',
    activeStepId: 'resolve',
    activeSkillBody: ''
  }
  const effectRecorder = new XForgeFileEffectRecorder(
    options.workspaceRoot,
    options.runId,
    () => runtime.activeStepId
  )
  const session = new XForgeMainAgentSession({
    ...options,
    getStage: () => runtime.activeStage,
    effectRecorder
  })

  try {
    // 任何业务写入前冻结 baseline；已存在则不可覆盖（commit 侧也会拒绝覆盖）。
    {
      const boot = options.committer.getSnapshot(options.runId)?.xforge
      if (!boot) throw new Error(`XForge run 不存在: ${options.runId}`)
      if (!boot.workspaceBaseline) {
        if (!options.initializeWorkspaceBaseline) {
          throw new Error('恢复的 XForge run 缺少 Workspace Baseline，拒绝从当前工作区重新捕获；请重新开始该 run')
        }
        const baseline = await captureXForgeWorkspaceBaseline(options.workspaceRoot)
        const patched = options.committer.commitXForgeStatePatch(
          options.runId,
          { workspaceBaseline: baseline },
          '冻结 XForge Workspace Baseline'
        )
        if (!patched.ok) throw new Error(patched.message)
      }
    }

    const hostOptions = {
      runId: options.runId,
      request: options.request,
      workspaceRoot: options.workspaceRoot,
      abortSignal: options.abortSignal,
      checkpointManager: options.checkpointManager,
      committer: options.committer,
      askQuestion: options.askQuestion
    }
    const stageHost = createXForgeLiveStageHost({
      session,
      runtime,
      options: hostOptions,
      resolveTaskVerificationCommand: resolveXForgeTaskVerificationCommand
    })
    const deliveryHost = createXForgeLiveDeliveryHost({
      session,
      runtime,
      options: {
        ...hostOptions,
        modelClient: options.modelClient,
        skillRegistry: options.skillRegistry,
        contextWindow: options.contextWindow
      }
    })

    const initial = options.committer.getSnapshot(options.runId)?.xforge
    if (!initial) throw new Error(`XForge run 不存在: ${options.runId}`)
    const importedPlan = initial.currentStage === 'resolve' && !initial.hasValidatedPlan
      ? await importReferencedValidatedPlan(options, session)
      : null
    if (importedPlan) {
      const beforeImport = options.committer.getSnapshot(options.runId)?.xforge
      if (!beforeImport) throw new Error(`XForge run 不存在: ${options.runId}`)
      const importedArtifact = writeXForgeArtifact({
        workspaceRoot: options.workspaceRoot,
        runId: options.runId,
        stage: 'plan',
        kind: 'plans',
        name: `imported-plan-v${importedPlan.plan.version}`,
        content: renderPlanArtifact(importedPlan.plan)
      })
      const patched = options.committer.commitXForgeStatePatch(options.runId, {
        hasValidatedPlan: true,
        hasValidScopePass: false,
        scopePass: null,
        planVersion: importedPlan.plan.version,
        validatedPlan: importedPlan.plan,
        tasks: createTaskStatesFromPlan(importedPlan.plan),
        mainSession: {
          ...beforeImport.mainSession,
          goal: beforeImport.mainSession.goal || importedPlan.plan.goal,
          constraints: [...importedPlan.plan.constraints],
          nonGoals: [...importedPlan.plan.nonGoals]
        },
        artifact: importedArtifact
      }, '导入用户引用的 Validated Plan')
      if (!patched.ok) throw new Error(patched.message)
    }

    const current = options.committer.getSnapshot(options.runId)?.xforge
    if (!current) throw new Error(`XForge run 不存在: ${options.runId}`)
    const resolverInput = {
      ...(current.currentStage === 'resolve'
        ? await resolveXForgeRequestSignals(options)
        : classifyXForgeRequest(options.request, options.explicitFullDev === true)),
      ...(importedPlan
        ? {
            hasValidatedPlan: true,
            planVersion: importedPlan.plan.version,
            workspaceRevision: current.workspaceRevision,
            scopePass: current.scopePass
          }
        : {})
    }
    const resolver = current.currentStage === 'resolve'
      ? resolveStartStage(resolverInput)
      : null
    if (resolver) {
      const resolverPatch = {
        reviewOnly: resolver.reviewOnly,
        skippedStages: resolver.skippedStages,
        reviewTarget: resolveXForgeReviewTarget({
          reviewOnly: resolver.reviewOnly,
          codeReadyForTest: resolverInput.codeReadyForTest === true
        }),
        mainSession: {
          ...current.mainSession,
          goal: current.mainSession.goal || stripFullDevCommand(options.request)
        }
      }
      if (resolver.terminalSummary) {
        const completed = options.committer.commitXForgeStageTransition(options.runId, {
          ok: true,
          from: current.currentStage,
          to: 'completed',
          reason: resolver.reason
        }, resolverPatch)
        if (!completed.ok) throw new Error(completed.message)
        return { state: completed.xforge, summary: resolver.terminalSummary }
      }
      const patched = options.committer.commitXForgeStatePatch(options.runId, resolverPatch, resolver.reason)
      if (!patched.ok) throw new Error(patched.message)
    }

    const preDelivery = new XForgeStageExecutor({
      runId: options.runId,
      committer: options.committer,
      host: stageHost,
      methodRegistry: options.skillRegistry,
      startStage: resolver?.startStage ?? resumeStartStage(current),
      explorationContext: inferExplorationContext(options.request)
    })
    const delivery = new XForgeDeliveryExecutor({
      runId: options.runId,
      committer: options.committer,
      host: deliveryHost,
      methodRegistry: options.skillRegistry
    })

    try {
      const state = await new XForgeExecutionPipeline(preDelivery, delivery).runToBoundary()
      return { state, summary: renderLiveSummary(state) }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const failed = options.committer.getSnapshot(options.runId)?.xforge
      if (failed && !['completed', 'failed', 'cancelled'].includes(failed.currentStage)) {
        options.committer.commitXForgeStageTransition(options.runId, {
          ok: true,
          from: failed.currentStage,
          to: 'failed',
          reason
        })
      }
      throw error
    }
  } finally {
    session.dispose()
  }
}

function resumeStartStage(state: XForgeRunState): XForgeStartStage {
  if (state.currentStage === 'brainstorm' || state.currentStage === 'plan' ||
      state.currentStage === 'scope_check' || state.currentStage === 'implement' ||
      state.currentStage === 'test' || state.currentStage === 'review') {
    return state.currentStage
  }
  return 'brainstorm'
}

function inferExplorationContext(input: string): { newProject?: boolean; systemLevelChange?: boolean } {
  return {
    newProject: /(新项目|从零|greenfield)/i.test(input),
    systemLevelChange: /(系统级|架构重构|全量重构|底层重构)/i.test(input)
  }
}

function renderLiveSummary(state: XForgeRunState): string {
  if (state.currentStage === 'completed') {
    const facts = state.reportFacts
    const reportPath = state.stageArtifacts.find(item => item.stage === 'report')?.path
    if (!facts) {
      return [
        'XForge 已完成。',
        '未执行 commit、push、deploy 或 publish。',
        reportPath ? `报告：${reportPath}` : ''
      ].filter(Boolean).join('\n')
    }
    const commandLines = facts.testCommands.length > 0
      ? facts.testCommands.map(command => {
          const status = command.blockedReason
            ? `阻塞：${command.blockedReason}`
            : command.timedOut
              ? '超时'
              : command.exitCode === null
                ? '未执行'
                : `exitCode=${command.exitCode}`
          return `- \`${command.command}\`：${status}${command.required ? '（必需）' : ''}`
        })
      : ['- 未记录可执行验证命令']
    const taskLines = [
      `- 已验证完成：${facts.completedTasks.join('、') || '无'}`,
      `- 未定向验证：${facts.unverifiedTasks.join('、') || '无'}`,
      `- 跳过：${facts.skippedTasks.map(task => `${task.id}（${task.reason}）`).join('、') || '无'}`
    ]
    const debtLines = facts.technicalDebt.length > 0
      ? facts.technicalDebt.map(finding => `- [${finding.severity}] ${finding.location}: ${finding.summary}`)
      : ['- 无']
    return [
      'XForge 已完成实施、真实验证与隔离审查。',
      '',
      `测试门禁：${facts.testPassed ? '通过' : '未通过'}`,
      ...commandLines,
      '',
      '任务结果：',
      ...taskLines,
      '',
      '隔离 Review：',
      `- Blocking Findings：${facts.blockingFindings.length}`,
      '技术债：',
      ...debtLines,
      '',
      `预算消耗：Scope ${facts.budgets.scopeCorrectionUsed}/2；Test-Fix ${facts.budgets.deliveryTestFixUsed}/3；Review-Fix ${facts.budgets.reviewRemediationUsed}/2。`,
      `未执行：${facts.notExecuted.join('、')}。`,
      reportPath ? `报告：${reportPath}` : ''
    ].filter(Boolean).join('\n')
  }
  if (state.currentStage === 'waiting_user') {
    return `XForge 已安全暂停：${state.waitingReason ?? '需要用户输入'}\n回复后将从 ${state.resumeTarget ?? state.suspendedStage ?? '当前阶段'} 继续。`
  }
  return `XForge 当前阶段：${state.currentStage}`
}

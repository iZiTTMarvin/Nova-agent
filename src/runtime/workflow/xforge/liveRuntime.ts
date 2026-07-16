import { randomUUID } from 'crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'fs'
import { resolve, sep } from 'path'
import type { AskQuestionAnswer, AskQuestionItem } from '../../../shared/askQuestion/types'
import type { ModelClient } from '../../model/ModelClient'
import type { ModelClientPool } from '../../model/ModelClientPool'
import { AgentLoop } from '../../agent/AgentLoop'
import { EventBus } from '../../agent/EventBus'
import type { AgentEvent } from '../../agent/types'
import { PermissionManager } from '../../permissions/PermissionManager'
import type { CheckpointManager } from '../../checkpoints/CheckpointManager'
import type { ToolRegistry } from '../../tools/ToolRegistry'
import type { SkillRegistry } from '../../skills/SkillRegistry'
import type { ReadState } from '../../tools/editTool'
import { createReadState } from '../../tools/editTool'
import {
  XForgeDeliveryExecutor,
  type XForgeControlledTestCommand,
  type XForgeDeliveryHost,
  type XForgeReviewInputSnapshot
} from './deliveryExecutor'
import {
  captureXForgeWorkspaceFingerprint,
  createXForgeReviewSnapshot,
  recordXForgeTestEvidence,
  resolveXForgeVerificationTimeout,
  runXForgeControlledTestCommand,
  writeXForgeRuntimeReport
} from './deliveryRuntime'
import { XForgeExecutionPipeline } from './executionPipeline'
import { XForgeFileEffectRecorder } from './effectRecorder'
import { resolveStartStage } from './stageResolver'
import {
  XForgeStageExecutor,
  buildMainAgentContext,
  type XForgeExplorationMethod,
  type XForgeRunCommitter,
  type XForgeStageHost
} from './stageExecutor'
import {
  createWorkspaceFingerprint,
  writeXForgeArtifact,
  writeXForgeEvidence
} from './stageArtifacts'
import { inspectXForgeTaskEffects, prepareXForgeWriteBoundary } from './writeSafety'
import {
  isForbiddenXForgeSideEffectCommand,
  isSafeRuntimeTestCommand
} from './deliveryExecutor'
import type {
  XForgeMainSessionState,
  XForgeReviewFindingState,
  XForgeRunState,
  XForgeScopeFindingState,
  XForgeTaskState
} from './runState'
import type { StageResolverInput, XForgeStage, XForgeStartStage } from './types'
import {
  createTaskStatesFromPlan,
  validateXForgePlan,
  type XForgeValidatedPlan
} from './plan'

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
}

export interface XForgeLiveRuntimeResult {
  state: XForgeRunState
  summary: string
}

interface BrainstormPayload {
  needsMoreClarification: boolean
  mainSession: XForgeMainSessionState
  artifactMarkdown: string
}

interface ExplorationQuestionsPayload {
  questions: AskQuestionItem[]
}

interface PlanPayload {
  plan: XForgeValidatedPlan
  artifactMarkdown: string
}

interface ScopePayload {
  findings: XForgeScopeFindingState[]
  artifactMarkdown: string
}

interface FixPayload {
  expandsScope: boolean
  artifactMarkdown: string
}

/** 产品入口使用的真实 XForge 执行宿主。 */
export async function runXForgeLiveRuntime(
  options: XForgeLiveRuntimeOptions
): Promise<XForgeLiveRuntimeResult> {
  let activeStage: XForgeStage =
    options.committer.getSnapshot(options.runId)?.xforge?.currentStage ?? 'resolve'
  let activeStepId = 'resolve'
  let activeSkillBody = ''
  const effectRecorder = new XForgeFileEffectRecorder(
    options.workspaceRoot,
    options.runId,
    () => activeStepId
  )
  const session = new XForgeMainAgentSession({
    ...options,
    getStage: () => activeStage,
    effectRecorder
  })

  const hostBase = {
    activateStage: async (params: { stage: XForgeStage; skill?: { body: string } }) => {
      throwIfAborted(options.abortSignal)
      activeStage = params.stage
      activeSkillBody = params.skill?.body ?? ''
    }
  }

  const stageHost: XForgeStageHost = {
    ...hostBase,
    askQuestion: async ({ questions }) => {
      throwIfAborted(options.abortSignal)
      return options.askQuestion(randomUUID(), questions)
    },
    buildExplorationQuestions: async ({ method, round, context }) => {
      const payload = await session.runJson<ExplorationQuestionsPayload>(stagePrompt(
        activeSkillBody,
        '需求澄清',
        options.request,
        { method, round, context },
        '根据用户目标和已知决策生成 1 到 3 条必须由用户回答的具体问题。问题要消除目标、约束、验收或不可触碰边界中的真实未知；不要使用泛化的“继续”问题。只返回 JSON：{"questions":[{"question":"...","options":[{"label":"...","description":"..."}],"custom":true}]}。'
      ), isExplorationQuestionsPayload)
      return payload.questions
    },
    runBrainstorm: async ({ method, round, answers, context }) => {
      const payload = await session.runJsonDecoded<BrainstormPayload>(stagePrompt(
        activeSkillBody,
        '需求探索',
        options.request,
        { method, round, answers, context },
        '判断现有信息是否足够形成可靠的探索产物。若仍缺少关键约束，返回 needsMoreClarification=true，并只给出当前已知 mainSession 与简短说明；不得伪造设计结论。若信息充足，返回 needsMoreClarification=false 和完整设计产物。返回 JSON：{"needsMoreClarification":false,"mainSession":{"goal":"...","constraints":["..."],"nonGoals":["..."],"userDecisions":["..."]},"artifactMarkdown":"..."}'
      ), value => normalizeXForgeBrainstormPayload(value, context.mainSession))
      return {
        needsMoreClarification: payload.needsMoreClarification,
        mainSession: payload.mainSession,
        ...(!payload.needsMoreClarification
          ? {
              artifact: writeXForgeArtifact({
                workspaceRoot: options.workspaceRoot,
                runId: options.runId,
                stage: 'brainstorm',
                kind: 'idea',
                name: method,
                content: payload.artifactMarkdown
              })
            }
          : {})
      }
    },
    runPlan: async ({ previousPlan, missing, scopeFindings, nextPlanVersion, context }) => {
      const payload = await session.runJson<PlanPayload>(stagePrompt(
        activeSkillBody,
        '生成可执行实施计划',
        options.request,
        { previousPlan, missing, scopeFindings, nextPlanVersion, context },
        '返回 JSON：{"plan":{"version":1,"goal":"...","constraints":["..."],"nonGoals":["..."],"repositoryFacts":["..."],"changeScope":["..."],"tasks":[{"id":"T1","title":"...","acceptance":["..."]}],"acceptanceMap":{"T1":["..."]},"verificationChecklist":["`npm ...`"],"risks":["..."]},"artifactMarkdown":"..."}。任务必须可直接实施；verificationChecklist 只能列出计划已明确的安全验证命令，未知时返回空数组，不能猜测仓库全量命令。'
      ), isPlanPayload)
      payload.plan.version = nextPlanVersion
      return {
        plan: payload.plan,
        artifact: writeXForgeArtifact({
          workspaceRoot: options.workspaceRoot,
          runId: options.runId,
          stage: 'plan',
          kind: 'plans',
          name: `plan-v${nextPlanVersion}`,
          content: payload.artifactMarkdown
        })
      }
    },
    runScopeCheck: async ({ plan, context }) => {
      const payload = await session.runJson<ScopePayload>(stagePrompt(
        activeSkillBody,
        '对抗式 Scope Check',
        options.request,
        { plan, context },
        '返回 JSON：{"findings":[{"severity":"critical|high|medium|low","location":"...","summary":"...","evidence":"...","suggestion":"..."}],"artifactMarkdown":"..."}。没有问题时 findings 必须是空数组。'
      ), isScopePayload)
      const artifact = writeXForgeArtifact({
        workspaceRoot: options.workspaceRoot,
        runId: options.runId,
        stage: 'scope_check',
        kind: 'evidence',
        name: 'scope-check',
        content: payload.artifactMarkdown
      })
      const evidenceRef = writeXForgeEvidence({
        workspaceRoot: options.workspaceRoot,
        runId: options.runId,
        kind: 'scope-check',
        name: `scope-${Date.now()}`,
        content: payload.artifactMarkdown
      })
      return { findings: payload.findings, artifact, evidenceRef }
    },
    prepareWriteBoundary: async ({ checkpointRef, workspaceRevision }) =>
      prepareXForgeWriteBoundary({
        checkpointManager: options.checkpointManager,
        workspaceRoot: options.workspaceRoot,
        checkpointRef,
        workspaceRevision
      }),
    runImplementTask: async ({ task, attempt, context }) => {
      activeStepId = task.id
      const existingEffectIds = new Set(inspectXForgeTaskEffects({
        workspaceRoot: options.workspaceRoot,
        runId: options.runId,
        taskId: task.id
      }).effects.map(effect => effect.receiptId))
      const before = createWorkspaceFingerprint(options.workspaceRoot, {
        revision: context.planVersion ?? 0
      })
      await session.run(stagePrompt(
        '',
        `实施任务 ${task.id}`,
        options.request,
        { task, attempt, context },
        '直接使用 read/grep/find/edit/write 完成任务。不要运行测试、构建、commit、push 或部署；验证由 Runtime 执行。最后简洁说明改动。'
      ))
      const fullInspection = inspectXForgeTaskEffects({
        workspaceRoot: options.workspaceRoot,
        runId: options.runId,
        taskId: task.id
      })
      const newEffects = fullInspection.effects.filter(
        effect => !existingEffectIds.has(effect.receiptId)
      )
      const unsafeEffects = fullInspection.corruptReceiptIds.map(receiptId => ({
        path: `corrupt-receipt:${receiptId}`,
        status: 'prepared' as const
      }))
      const effects = fullInspection.pending.length > 0 || unsafeEffects.length > 0
        ? [...fullInspection.effects, ...unsafeEffects]
        : newEffects
      const current = options.committer.getSnapshot(options.runId)?.xforge
      if (!current) throw new Error('XForge 状态在任务实施后丢失')
      const hasWrites = newEffects.length > 0
      const fingerprint = createWorkspaceFingerprint(options.workspaceRoot, {
        revision: current.workspaceRevision + (hasWrites ? 1 : 0)
      })
      const command = resolveXForgeTaskVerificationCommand(current, task)
      const runtimeResult = command
        ? await runXForgeControlledTestCommand(
            { workspaceRoot: options.workspaceRoot, runId: options.runId, abortSignal: options.abortSignal },
            command
          )
        : {
            exitCode: null,
            timedOut: false,
            evidenceRef: { kind: 'task-verification', unverified: true }
          }
      if (before.digest === fingerprint.digest && hasWrites) {
        throw new Error('EffectReceipt 显示有写入，但 Workspace Fingerprint 未变化')
      }
      return {
        verification: {
          outcome: !command
            ? 'unverified'
            : runtimeResult.blockedReason
              ? 'blocked'
              : runtimeResult.exitCode === 0 && !runtimeResult.timedOut
                ? 'passed'
                : 'failed',
          command: command?.command ?? null,
          exitCode: runtimeResult.exitCode,
          timedOut: runtimeResult.timedOut,
          ...(runtimeResult.blockedReason ? { blockedReason: runtimeResult.blockedReason } : {})
        },
        evidenceRef: runtimeResult.evidenceRef,
        fileEffects: effects,
        workspaceFingerprint: fingerprint,
        ...(fullInspection.pending.length > 0 || unsafeEffects.length > 0
          ? { failureReason: '存在未提交或损坏的 EffectReceipt' }
          : {})
      }
    },
    completeImplement: async ({ tasks }) => ({
      artifact: writeXForgeArtifact({
        workspaceRoot: options.workspaceRoot,
        runId: options.runId,
        stage: 'implement',
        kind: 'evidence',
        name: 'implementation-summary',
        content: renderTaskSummary(tasks)
      })
    })
  }

  const deliveryHost: XForgeDeliveryHost = {
    ...hostBase,
    captureWorkspaceFingerprint: async ({ workspaceRevision }) =>
      captureXForgeWorkspaceFingerprint(options.workspaceRoot, workspaceRevision),
    resolveControlledTestCommands: async ({ state }) => ({
      commands: resolveXForgeDeliveryCommands(state)
    }),
    runControlledCommand: async ({ command }) =>
      runXForgeControlledTestCommand(
        { workspaceRoot: options.workspaceRoot, runId: options.runId, abortSignal: options.abortSignal },
        command
      ),
    recordTestEvidence: async ({ evidence }) =>
      recordXForgeTestEvidence(
        { workspaceRoot: options.workspaceRoot, runId: options.runId },
        evidence
      ),
    createReviewSnapshot: async () =>
      createXForgeReviewSnapshot({ workspaceRoot: options.workspaceRoot, runId: options.runId }),
    runReviewSubagent: async ({ input }) => {
      const reviewSkill = options.skillRegistry.get('br-review')
      if (!reviewSkill || reviewSkill.invalid || !reviewSkill.enabled || !reviewSkill.body.trim()) {
        throw new Error('隔离 Review 子代理所需方法 br-review 缺失或无效')
      }
      return runIsolatedReview(options, input, reviewSkill.body)
    },
    prepareWriteBoundary: stageHost.prepareWriteBoundary,
    runFix: async ({ state, failedTest, blockingFindings }) => {
      activeStepId = `fix-${state.deliveryTestFixUsed}-${state.reviewRemediationUsed}`
      const payload = await session.runJson<FixPayload>(stagePrompt(
        activeSkillBody,
        '根因修复',
        options.request,
        { failedTest, blockingFindings, state: buildMainAgentContext(state) },
        '先定位根因，再使用工具完成最小且完整的修复。不要运行验证命令。返回 JSON：{"expandsScope":false,"artifactMarkdown":"..."}。若修复超出当前计划 changeScope，expandsScope 必须为 true。'
      ), isFixPayload)
      const inspection = inspectXForgeTaskEffects({
        workspaceRoot: options.workspaceRoot,
        runId: options.runId,
        taskId: activeStepId
      })
      const fileEffects = [
        ...inspection.effects,
        ...inspection.corruptReceiptIds.map(receiptId => ({
          path: `corrupt-receipt:${receiptId}`,
          status: 'prepared' as const
        }))
      ]
      const hasWrites = inspection.effects.length > 0
      const fingerprint = createWorkspaceFingerprint(options.workspaceRoot, {
        revision: state.workspaceRevision + (hasWrites ? 1 : 0)
      })
      return {
        expandsScope: payload.expandsScope,
        fileEffects,
        workspaceFingerprint: fingerprint,
        artifact: writeXForgeArtifact({
          workspaceRoot: options.workspaceRoot,
          runId: options.runId,
          stage: 'fix',
          kind: 'evidence',
          name: activeStepId,
          content: payload.artifactMarkdown
        })
      }
    },
    askShipIntent: async () => {
      const answers = await options.askQuestion(randomUUID(), [{
        question: 'XForge 已完成验证与审查。是否记录为需要你后续自行 ship 的交接项？本流程不会执行 commit、push、deploy 或 publish。',
        options: [
          { label: '暂不交接', description: '保持默认安全行为，不记录后续 ship 意图。' },
          { label: '记录后续 ship', description: '仅记录你的交接意图，不执行任何 Git 或发布操作。' }
        ],
        custom: false
      }])
      return answers.some(answer => answer.selectedLabels?.includes('记录后续 ship'))
    },
    writeReport: async ({ facts }) =>
      writeXForgeRuntimeReport(
        { workspaceRoot: options.workspaceRoot, runId: options.runId },
        facts
      )
  }

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
      content: importedPlan.artifactMarkdown
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
    ...classifyXForgeRequest(options.request, options.explicitFullDev === true),
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
    const patched = options.committer.commitXForgeStatePatch(options.runId, {
      reviewOnly: resolver.reviewOnly,
      skippedStages: resolver.skippedStages,
      mainSession: {
        ...current.mainSession,
        goal: current.mainSession.goal || stripFullDevCommand(options.request)
      }
    }, resolver.reason)
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
  } finally {
    session.dispose()
  }
}

async function importReferencedValidatedPlan(
  options: XForgeLiveRuntimeOptions,
  session: XForgeMainAgentSession
): Promise<PlanPayload | null> {
  if (options.explicitFullDev) return null
  const referencedPath = extractReferencedMarkdownPath(options.request)
  if (!referencedPath) return null

  const root = realpathSync(options.workspaceRoot)
  const candidate = resolve(root, referencedPath)
  if (candidate !== root && !candidate.startsWith(root + sep)) return null
  if (!existsSync(candidate)) return null
  const target = realpathSync(candidate)
  if (target !== root && !target.startsWith(root + sep)) return null
  const stats = statSync(target)
  if (!stats.isFile() || stats.size > 512 * 1024) return null
  const markdown = readFileSync(target, 'utf8')
  if (!looksLikeImportablePlan(markdown)) return null

  const payload = await session.runJson<PlanPayload>([
    '把用户引用的实施计划规范化为 XForge Validated Plan。只能抽取文档已经明确写出的事实，不得补写或猜测缺失内容。',
    '只返回 JSON：{"plan":{"version":1,"goal":"...","constraints":["..."],"nonGoals":["..."],"repositoryFacts":["..."],"changeScope":["..."],"tasks":[{"id":"T1","title":"...","acceptance":["..."]}],"acceptanceMap":{"T1":["..."]},"verificationChecklist":["`npm ...`"],"risks":["..."]},"artifactMarkdown":"..."}。verificationChecklist 只能保留文档明确给出的安全命令；没有命令时返回空数组。',
    `引用路径：${referencedPath}`,
    markdown
  ].join('\n\n'), isPlanPayload)
  const validation = validateXForgePlan(payload.plan)
  return validation.valid ? payload : null
}

function extractReferencedMarkdownPath(input: string): string | null {
  const match = input.match(/`([^`]+\.md)`|"([^"]+\.md)"|'([^']+\.md)'|([A-Za-z0-9_./\\-]+\.md)\b/i)
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? match?.[4] ?? null)?.trim() ?? null
}

function looksLikeImportablePlan(markdown: string): boolean {
  const hasTasks = /(?:^|\n)\s*(?:-\s*\[[ xX]\]|\d+[.)])\s+\S/m.test(markdown)
  const hasAcceptance = /(验收|acceptance|完成条件|definition of done)/i.test(markdown)
  const hasScope = /(变更范围|change scope|涉及文件|修改文件|模块)/i.test(markdown)
  const hasRisk = /(风险|risk|回退|rollback)/i.test(markdown)
  return hasTasks && hasAcceptance && hasScope && hasRisk
}

class XForgeMainAgentSession {
  private readonly loop: AgentLoop
  private readonly bus = new EventBus()
  private output = ''
  private currentInternalMessageId = ''
  private readonly unsubscribe: () => void
  private readonly onAbort: () => void

  constructor(
    private readonly options: XForgeLiveRuntimeOptions & {
      getStage: () => XForgeStage
      effectRecorder: XForgeFileEffectRecorder
    }
  ) {
    this.unsubscribe = this.bus.on(event => this.handleEvent(event))
    this.loop = new AgentLoop(options.modelClient, this.bus, {
      systemPrompt: [
        '你是 XForge 的单一主 Agent。阶段用于组织工作和质量门禁，不改变基础工具权限。',
        '只处理当前阶段；不得 commit、push、deploy 或 publish；不得把模型自报当作测试结果。',
        '阶段交互与产物持久化由 Runtime 负责。方法正文里的提问、写文件和返回格式说明只作领域参考，若与当前 Runtime 指令冲突，以 Runtime 指令为准。',
        '需要输出 JSON 时只输出一个 JSON 对象，不要使用 Markdown 围栏。'
      ].join('\n'),
      maxToolRounds: 30,
      contextWindow: options.contextWindow,
      supportsVision: options.supportsVision ?? true,
      toolExecution: 'sequential',
      useUnifiedSkillDispatch: false,
      composeAutoRoute: false
    })
    const permission = new PermissionManager()
    permission.setPermissionPolicy('auto')
    permission.setCurrentProjectPath(options.workspaceRoot)
    this.loop.setPermissionManager(permission)
    this.loop.setMode('compose')
    this.loop.setWorkingDir(options.workspaceRoot)
    this.loop.setToolRegistry(options.toolRegistry)
    this.loop.setCheckpointManager(options.checkpointManager)
    this.loop.setReadState(options.readState ?? createReadState())
    this.loop.setAskQuestionHandler(options.askQuestion)
    this.loop.setFileEffectRecorder(options.effectRecorder)
    this.loop.setToolAuthorizationPolicy((toolName, args) => {
      const command = toolName === 'bash' && typeof args.command === 'string'
        ? args.command
        : ''
      return command && isForbiddenXForgeSideEffectCommand(command)
        ? { allowed: false, reason: 'XForge 不执行 commit、push、reset、clean、deploy 或 publish' }
        : { allowed: true, reason: '' }
    })
    if (options.assertExecutionCurrent) {
      this.loop.setExecutionFence(options.assertExecutionCurrent)
    }
    this.onAbort = () => this.loop.cancel()
    options.abortSignal?.addEventListener('abort', this.onAbort)
  }

  async run(prompt: string): Promise<string> {
    throwIfAborted(this.options.abortSignal)
    this.output = ''
    await this.loop.sendMessage(prompt)
    throwIfAborted(this.options.abortSignal)
    if (this.loop.getState() === 'error' || this.loop.getState() === 'cancelled') {
      throw new Error(`XForge 主 Agent 在 ${this.options.getStage()} 阶段未正常完成`)
    }
    const result = this.output.trim()
    if (!result) throw new Error(`XForge 主 Agent 在 ${this.options.getStage()} 阶段返回空结果`)
    return result
  }

  async runJson<T>(prompt: string, validate: (value: unknown) => value is T): Promise<T> {
    return this.runJsonDecoded(prompt, value => validate(value) ? value : null)
  }

  async runJsonDecoded<T>(prompt: string, decode: (value: unknown) => T | null): Promise<T> {
    let last = ''
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      last = await this.run(attempt === 1
        ? prompt
        : [
            '上一轮工作已经完成，但返回格式无法通过结构校验。',
            '不要重新分析、提问、调用工具或写文件；只把上一轮结果转换成最后一条 Runtime 指令要求的单个合法 JSON 对象。',
            'JSON 字符串中的换行和引号必须正确转义。'
          ].join('\n'))
      const parsed = parseJsonObject(last)
      const decoded = decode(parsed)
      if (decoded !== null) return decoded
    }
    throw new Error(`XForge ${this.options.getStage()} 阶段返回的结构化结果无效: ${last.slice(0, 240)}`)
  }

  dispose(): void {
    this.options.abortSignal?.removeEventListener('abort', this.onAbort)
    this.unsubscribe()
    this.loop.dispose()
  }

  private handleEvent(event: AgentEvent): void {
    if (event.type === 'message_start') {
      this.currentInternalMessageId = event.messageId
      return
    }
    if (event.type === 'text_delta' && event.messageId === this.currentInternalMessageId) {
      this.output += event.delta
      return
    }
    if (!('messageId' in event) || event.type === 'message_end') return
    const forwardable = new Set([
      'thinking_delta',
      'tool_call_start',
      'tool_call_delta',
      'tool_call',
      'tool_result',
      'permission_request',
      'diff_update',
      'verification_result',
      'verification_permission_request',
      'verification_permission_cleared',
      'usage',
      'error',
      'hook_error'
    ])
    if (forwardable.has(event.type)) {
      this.options.parentEventBus.emit({
        ...event,
        messageId: this.options.parentMessageId
      } as AgentEvent)
    }
  }
}

async function runIsolatedReview(
  options: XForgeLiveRuntimeOptions,
  input: Readonly<XForgeReviewInputSnapshot>,
  skillBody: string
) {
  const bus = new EventBus()
  let output = ''
  let messageId = ''
  const unsub = bus.on(event => {
    if (event.type === 'message_start') messageId = event.messageId
    if (event.type === 'text_delta' && event.messageId === messageId) output += event.delta
  })
  const loop = new AgentLoop(options.modelClient, bus, {
    systemPrompt: [
      '你是隔离、只读的代码审查 Agent。你没有任何工具，只能审查 Runtime 提供的不可变快照。',
      skillBody
    ].join('\n\n'),
    maxToolRounds: 1,
    contextWindow: options.contextWindow,
    useUnifiedSkillDispatch: false,
    composeAutoRoute: false
  })
  loop.setMode('plan')
  const onAbort = () => loop.cancel()
  options.abortSignal?.addEventListener('abort', onAbort)
  try {
    await loop.sendMessage([
      '请审查下面的 XForge Review Input Snapshot。',
      '只返回 JSON：{"findings":[{"severity":"critical|high|medium|low|nit","location":"file:line","summary":"...","evidence":"...","suggestion":"...","unverified":false}]}。没有问题时 findings 为空数组。',
      JSON.stringify(input)
    ].join('\n\n'))
    throwIfAborted(options.abortSignal)
    const parsed = parseJsonObject(output) as { findings?: unknown } | null
    const findings = parsed && isReviewFindings(parsed.findings) ? parsed.findings : null
    if (!findings) throw new Error('隔离 Review 子代理返回了无效 findings')
    const markdown = renderReviewFindings(findings)
    return {
      findings,
      artifact: writeXForgeArtifact({
        workspaceRoot: options.workspaceRoot,
        runId: options.runId,
        stage: 'review',
        kind: 'evidence',
        name: `review-${Date.now()}`,
        content: markdown
      }),
      evidenceRef: writeXForgeEvidence({
        workspaceRoot: options.workspaceRoot,
        runId: options.runId,
        kind: 'review',
        name: `review-${Date.now()}`,
        content: markdown
      })
    }
  } finally {
    options.abortSignal?.removeEventListener('abort', onAbort)
    unsub()
    loop.dispose()
  }
}

export function classifyXForgeRequest(
  input: string,
  explicitFullDev = false
): StageResolverInput {
  const text = stripFullDevCommand(input)
  if (explicitFullDev) return { isVagueNewRequirement: true, requestedStartStage: 'brainstorm' }
  const reviewOnly = /(只|仅).{0,8}(审查|review)|不要改(代码|文件)|禁止修改/i.test(text)
  const codeReadyForTest = /(已经|已).{0,10}(改好|完成|实现).{0,12}(测试|检查|验证)|从测试开始/i.test(text)
  const isBugfix = /(修复|bug|报错|故障|崩溃|异常)/i.test(text) && !codeReadyForTest
  const hasDesignOnlyDoc = /(?:\.md\b|设计文档|方案文档|需求文档)/i.test(text)
  const requestedStartStage = parseRequestedStage(text)
  const vague = /(还没想清楚|不确定|想做|我想|我打算|帮我想|探索一下|需求模糊|你觉得|有什么建议|怎么看)/i.test(text)
  return {
    reviewOnly,
    codeReadyForTest,
    isBugfix,
    hasDesignOnlyDoc,
    isVagueNewRequirement: vague,
    ...(requestedStartStage ? { requestedStartStage } : {}),
    modelSemanticHint: vague ? 'brainstorm' : 'plan'
  }
}

function parseRequestedStage(text: string): XForgeStartStage | undefined {
  if (/从(需求探索|brainstorm)开始/i.test(text)) return 'brainstorm'
  if (/从(计划|plan)开始/i.test(text)) return 'plan'
  if (/从(scope|范围审查)开始/i.test(text)) return 'scope_check'
  if (/从(实现|开发|implement)开始/i.test(text)) return 'implement'
  if (/从(测试|test)开始/i.test(text)) return 'test'
  if (/从(审查|review)开始/i.test(text)) return 'review'
  return undefined
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

export function resolveXForgeTaskVerificationCommand(
  state: XForgeRunState,
  task: XForgeTaskState
): XForgeControlledTestCommand | null {
  const candidates = state.validatedPlan?.acceptanceMap[task.id] ?? []
  const command = extractCommands(candidates).find(isSafeRuntimeTestCommand)
  return command
    ? {
        command,
        required: true,
        reason: `任务 ${task.id} 验收`,
        timeoutMs: resolveXForgeVerificationTimeout(command)
      }
    : null
}

export function resolveXForgeDeliveryCommands(
  state: XForgeRunState
): XForgeControlledTestCommand[] {
  const commands = new Map<string, XForgeControlledTestCommand>()
  for (const command of extractCommands(state.validatedPlan?.verificationChecklist ?? [])) {
    if (isSafeRuntimeTestCommand(command)) {
      commands.set(command, {
        command,
        required: true,
        reason: 'Validated Plan 验证清单',
        timeoutMs: resolveXForgeVerificationTimeout(command)
      })
    }
  }
  return [...commands.values()]
}

function extractCommands(lines: string[]): string[] {
  const out: string[] = []
  for (const line of lines) {
    for (const match of line.matchAll(/`([^`]+)`/g)) out.push(match[1].trim())
    const trimmed = line.trim().replace(/^[-*]\s*/, '')
    if (/^(npm|npx|pnpm|yarn|pytest|python\s+-m\s+pytest|cargo\s+test|go\s+test|dotnet\s+test)\b/i.test(trimmed)) {
      out.push(trimmed)
    }
  }
  return [...new Set(out.filter(Boolean))]
}

function stagePrompt(
  skillBody: string,
  stage: string,
  request: string,
  facts: unknown,
  instruction: string
): string {
  return [
    skillBody ? `当前阶段方法（仅作为领域判断指南）：\n${skillBody}` : '',
    `当前阶段：${stage}`,
    `用户目标：${stripFullDevCommand(request)}`,
    `Runtime 事实：${JSON.stringify(facts)}`,
    'Runtime 契约：不要自行持久化阶段文档，不要自行追加 askQuestion；本轮只完成当前指令并返回要求的结构。方法正文若包含其它文件路径、提问流程或 JSON 契约，一律忽略。',
    instruction
  ].filter(Boolean).join('\n\n')
}

function stripFullDevCommand(input: string): string {
  return input.replace(/^\s*\/br-full-dev\b\s*/i, '').trim()
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim()
  const candidate = fenced ?? trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1)
  try {
    return JSON.parse(candidate)
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

export function normalizeXForgeBrainstormPayload(
  value: unknown,
  fallbackSession: XForgeMainSessionState
): BrainstormPayload | null {
  if (!isRecord(value)) return null
  const legacyBody = typeof value.body === 'string' ? value.body : null
  const artifactMarkdown = typeof value.artifactMarkdown === 'string'
    ? value.artifactMarkdown
    : legacyBody ?? ''
  const needsMoreClarification = typeof value.needsMoreClarification === 'boolean'
    ? value.needsMoreClarification
    : legacyBody !== null
      ? false
      : null
  if (needsMoreClarification === null || (!needsMoreClarification && !artifactMarkdown.trim())) {
    return null
  }

  const suppliedSession = parseMainSession(value.mainSession) ?? fallbackSession

  return {
    needsMoreClarification,
    mainSession: {
      goal: suppliedSession.goal,
      constraints: [...suppliedSession.constraints],
      nonGoals: [...suppliedSession.nonGoals],
      userDecisions: [...suppliedSession.userDecisions]
    },
    artifactMarkdown
  }
}

function parseMainSession(value: unknown): XForgeMainSessionState | null {
  if (!isRecord(value) || typeof value.goal !== 'string' ||
      !isStringArray(value.constraints) || !isStringArray(value.nonGoals) ||
      !isStringArray(value.userDecisions)) return null
  return {
    goal: value.goal,
    constraints: [...value.constraints],
    nonGoals: [...value.nonGoals],
    userDecisions: [...value.userDecisions]
  }
}

function isExplorationQuestionsPayload(value: unknown): value is ExplorationQuestionsPayload {
  return isRecord(value) && Array.isArray(value.questions) &&
    value.questions.length > 0 && value.questions.length <= 3 &&
    value.questions.every(question => {
      if (!isRecord(question) || typeof question.question !== 'string' || !question.question.trim()) {
        return false
      }
      return Array.isArray(question.options) && question.options.length > 0 &&
        question.options.every(option => isRecord(option) &&
          typeof option.label === 'string' && option.label.trim().length > 0)
    })
}

function isPlanPayload(value: unknown): value is PlanPayload {
  return isRecord(value) && isRecord(value.plan) && typeof value.artifactMarkdown === 'string'
}

function isScopePayload(value: unknown): value is ScopePayload {
  return isRecord(value) && Array.isArray(value.findings) &&
    value.findings.every(isScopeFinding) && typeof value.artifactMarkdown === 'string'
}

function isScopeFinding(value: unknown): value is XForgeScopeFindingState {
  return isRecord(value) && ['critical', 'high', 'medium', 'low'].includes(String(value.severity)) &&
    typeof value.location === 'string' && typeof value.summary === 'string' &&
    typeof value.evidence === 'string' && typeof value.suggestion === 'string'
}

function isFixPayload(value: unknown): value is FixPayload {
  return isRecord(value) && typeof value.expandsScope === 'boolean' &&
    typeof value.artifactMarkdown === 'string'
}

function isReviewFindings(value: unknown): value is XForgeReviewFindingState[] {
  return Array.isArray(value) && value.every(finding =>
    isRecord(finding) && ['critical', 'high', 'medium', 'low', 'nit'].includes(String(finding.severity)) &&
    typeof finding.location === 'string' && typeof finding.summary === 'string' &&
    typeof finding.evidence === 'string'
  )
}

function renderTaskSummary(tasks: XForgeTaskState[]): string {
  return ['# Implementation Summary', '', ...tasks.map(task =>
    `- ${task.id} ${task.title}: ${task.status}${task.failureReason ? ` — ${task.failureReason}` : ''}`
  )].join('\n')
}

function renderReviewFindings(findings: XForgeReviewFindingState[]): string {
  return ['# Review Findings', '', ...(findings.length === 0
    ? ['No findings.']
    : findings.map(finding => `- [${finding.severity}] ${finding.location}: ${finding.summary}\n  - Evidence: ${finding.evidence}`)
  )].join('\n')
}

function renderLiveSummary(state: XForgeRunState): string {
  if (state.currentStage === 'completed') {
    const facts = state.reportFacts
    return [
      'XForge 已完成实施、真实验证与隔离审查。',
      facts ? `测试门禁：${facts.testPassed ? '通过' : '未通过'}；已验证完成 ${facts.completedTasks.length} 个；未定向验证 ${facts.unverifiedTasks.length} 个；跳过 ${facts.skippedTasks.length} 个。` : '',
      '未执行 commit、push、deploy 或 publish。',
      state.stageArtifacts.find(item => item.stage === 'report')?.path
        ? `报告：${state.stageArtifacts.find(item => item.stage === 'report')!.path}`
        : ''
    ].filter(Boolean).join('\n')
  }
  if (state.currentStage === 'waiting_user') {
    return `XForge 已安全暂停：${state.waitingReason ?? '需要用户输入'}\n回复后将从 ${state.resumeTarget ?? state.suspendedStage ?? '当前阶段'} 继续。`
  }
  return `XForge 当前阶段：${state.currentStage}`
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('XForge 执行已取消')
}

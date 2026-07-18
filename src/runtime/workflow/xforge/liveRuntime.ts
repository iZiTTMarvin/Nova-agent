import { randomUUID } from 'crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'fs'
import { resolve, sep } from 'path'
import type { AskQuestionAnswer, AskQuestionItem } from '../../../shared/askQuestion/types'
import { getToolCapability } from '../../../shared/session/toolVisibility'
import type { ModelClient } from '../../model/ModelClient'
import type { ModelClientPool } from '../../model/ModelClientPool'
import type { ChatMessage } from '../../model/types'
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
  designNotes: string[]
}

interface ExplorationQuestionsPayload {
  questions: AskQuestionItem[]
}

interface PlanPayload {
  plan: XForgeValidatedPlan
}

interface ScopePayload {
  findings: XForgeScopeFindingState[]
}

interface FixPayload {
  expandsScope: boolean
}

interface ResolverSemanticPayload {
  reviewOnly: boolean
  codeReadyForTest: boolean
  isBugfix: boolean
  isVagueNewRequirement: boolean
  isNonDevRequest: boolean
  modelSemanticHint: 'brainstorm' | 'plan'
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
        '判断现有信息是否足够形成可靠的探索结论。若仍缺少关键约束，返回 needsMoreClarification=true，不得伪造设计结论。只返回紧凑 JSON：{"needsMoreClarification":false,"mainSession":{"goal":"...","constraints":["..."],"nonGoals":["..."],"userDecisions":["..."]},"designNotes":["..."]}。designNotes 只记录不与 mainSession 重复的关键设计判断，不要返回 Markdown。'
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
                content: renderBrainstormArtifact(payload)
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
        '只返回紧凑 JSON：{"plan":{"version":1,"goal":"...","constraints":["..."],"nonGoals":["..."],"repositoryFacts":["..."],"changeScope":["..."],"tasks":[{"id":"T1","title":"...","acceptance":["..."]}],"acceptanceMap":{"T1":["..."]},"verificationChecklist":["`npm ...`"],"risks":["..."]}}。不要返回 Markdown 或重复描述计划。任务必须可直接实施；生成计划前用只读工具确认仓库真实存在的安全验证命令，例如 package.json scripts 或 CI 配置；把确认过的命令原样写入 verificationChecklist。确认不了就返回空数组，不得编造或执行验证命令。'
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
          content: renderPlanArtifact(payload.plan)
        })
      }
    },
    runScopeCheck: async ({ plan, context }) => {
      const payload = await session.runJson<ScopePayload>(stagePrompt(
        activeSkillBody,
        '对抗式 Scope Check',
        options.request,
        { plan, context },
        '只返回紧凑 JSON：{"findings":[{"severity":"critical|high|medium|low","location":"...","summary":"...","evidence":"...","suggestion":"..."}]}。不要返回 Markdown；没有问题时 findings 必须是空数组。'
      ), isScopePayload)
      const artifactMarkdown = renderScopeArtifact(payload.findings)
      const artifact = writeXForgeArtifact({
        workspaceRoot: options.workspaceRoot,
        runId: options.runId,
        stage: 'scope_check',
        kind: 'evidence',
        name: 'scope-check',
        content: artifactMarkdown
      })
      const evidenceRef = writeXForgeEvidence({
        workspaceRoot: options.workspaceRoot,
        runId: options.runId,
        kind: 'scope-check',
        name: `scope-${Date.now()}`,
        content: artifactMarkdown
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
        '先定位根因，再使用工具完成最小且完整的修复。不要运行验证命令。只返回 JSON：{"expandsScope":false}。不要返回 Markdown；若修复超出当前计划 changeScope，expandsScope 必须为 true。'
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
          content: renderFixArtifact({
            expandsScope: payload.expandsScope,
            failedTest,
            blockingFindings,
            fileEffects
          })
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
  } finally {
    session.dispose()
  }
}

async function resolveXForgeRequestSignals(
  options: Pick<XForgeLiveRuntimeOptions, 'request' | 'explicitFullDev' | 'modelClient' | 'abortSignal'>
): Promise<StageResolverInput> {
  const deterministic = classifyXForgeRequest(options.request, options.explicitFullDev === true)
  if (options.explicitFullDev) return deterministic

  try {
    const semantic = await classifyXForgeRequestSemantically(
      stripFullDevCommand(options.request),
      options.modelClient,
      options.abortSignal
    )
    return mergeResolverSignals(deterministic, semantic)
  } catch {
    return {
      ...deterministic,
      modelSemanticHint: 'failed'
    }
  }
}

function mergeResolverSignals(
  deterministic: StageResolverInput,
  semantic: ResolverSemanticPayload
): StageResolverInput {
  const reviewOnly = deterministic.reviewOnly === true || semantic.reviewOnly
  const codeReadyForTest = deterministic.codeReadyForTest === true || semantic.codeReadyForTest
  const isBugfix = (deterministic.isBugfix === true || semantic.isBugfix) && !codeReadyForTest
  const devSignal =
    reviewOnly ||
    codeReadyForTest ||
    isBugfix ||
    deterministic.hasDesignOnlyDoc === true ||
    deterministic.requestedStartStage !== undefined

  return {
    ...deterministic,
    reviewOnly,
    codeReadyForTest,
    isBugfix,
    isVagueNewRequirement:
      deterministic.isVagueNewRequirement === true || semantic.isVagueNewRequirement,
    isNonDevRequest: semantic.isNonDevRequest && !devSignal,
    modelSemanticHint: semantic.modelSemanticHint
  }
}

async function classifyXForgeRequestSemantically(
  input: string,
  modelClient: ModelClient | ModelClientPool,
  abortSignal?: AbortSignal
): Promise<ResolverSemanticPayload> {
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: [
        '你是 XForge 的入口语义分类器。你没有工具，不要请求工具，不要解释。',
        'XForge 只面向代码开发、修复、测试、审查和可执行工程计划。',
        '只返回一个 JSON 对象：{"reviewOnly":boolean,"codeReadyForTest":boolean,"isBugfix":boolean,"isVagueNewRequirement":boolean,"isNonDevRequest":boolean,"modelSemanticHint":"brainstorm|plan"}。',
        'reviewOnly 表示用户要求只看、只审查、解释问题或明确不要动/不要改代码。',
        'isNonDevRequest 只用于普通问答、概念解释或闲聊；代码审查、调试、架构审查和测试请求都不是 non-dev。',
        'modelSemanticHint：需求模糊、目标未定、需要先探索时为 brainstorm；可直接形成工程计划时为 plan。'
      ].join('\n')
    },
    {
      role: 'user',
      content: `用户输入：\n${input}`
    }
  ]
  let output = ''
  for await (const event of modelClient.chat(messages, undefined, { abortSignal })) {
    if (event.type === 'text_delta') output += event.delta
    if (event.type === 'error') throw new Error(event.error)
    if (event.type === 'context_overflow') throw new Error(event.rawError)
    if (event.type === 'cancelled') throw new Error('resolver semantic classification cancelled')
  }
  const parsed = parseJsonObject(output)
  if (!isResolverSemanticPayload(parsed)) {
    throw new Error('resolver semantic classification returned invalid JSON')
  }
  return parsed
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
    '只返回紧凑 JSON：{"plan":{"version":1,"goal":"...","constraints":["..."],"nonGoals":["..."],"repositoryFacts":["..."],"changeScope":["..."],"tasks":[{"id":"T1","title":"...","acceptance":["..."]}],"acceptanceMap":{"T1":["..."]},"verificationChecklist":["`npm ...`"],"risks":["..."]}}。不要返回 Markdown；verificationChecklist 只能保留文档明确给出的安全命令，没有命令时返回空数组。',
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
        '你是 XForge 的单一主 Agent。阶段用于组织工作，Runtime 会按阶段收紧工具能力。',
        '只处理当前阶段；不得 commit、push、deploy 或 publish；不得把模型自报当作测试结果。',
        '阶段交互与产物持久化由 Runtime 负责。方法正文里的提问、写文件和返回格式说明只作领域参考，若与当前 Runtime 指令冲突，以 Runtime 指令为准。',
        '需要输出 JSON 时只输出一个 JSON 对象，不要使用 Markdown 围栏。'
      ].join('\n'),
      maxToolRounds: 30,
      contextWindow: options.contextWindow,
      supportsVision: options.supportsVision ?? true,
      toolExecution: 'sequential',
      useUnifiedSkillDispatch: false
    })
    const permission = new PermissionManager()
    permission.setPermissionPolicy('auto')
    permission.setCurrentProjectPath(options.workspaceRoot)
    this.loop.setPermissionManager(permission)
    this.loop.setMode('plan')
    this.loop.setWorkingDir(options.workspaceRoot)
    this.loop.setToolRegistry(options.toolRegistry)
    this.loop.setCheckpointManager(options.checkpointManager)
    this.loop.setReadState(options.readState ?? createReadState())
    this.loop.setAskQuestionHandler(options.askQuestion)
    this.loop.setFileEffectRecorder(options.effectRecorder)
    this.loop.setToolAuthorizationPolicy((toolName) => {
      const stage = options.getStage()
      const capability = getToolCapability(toolName)
      const isWritableStage = stage === 'implement' || stage === 'fix'
      if (toolName === 'askQuestion') {
        return { allowed: false, reason: 'XForge 用户交互只能由 Runtime 的阶段控制器发起' }
      }
      if (!isWritableStage && capability !== 'readonly') {
        return { allowed: false, reason: `XForge ${stage} 阶段只允许只读工具` }
      }
      if (isWritableStage && capability !== 'readonly' && capability !== 'write') {
        return {
          allowed: false,
          reason: 'XForge 实施与修复只允许读写文件；测试、构建和脚本执行由受控 Runtime 阶段负责'
        }
      }
      return { allowed: true, reason: '' }
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
    const stage = this.options.getStage()
    this.loop.setMode(stage === 'implement' || stage === 'fix' ? 'compose' : 'plan')
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
    const first = await this.run(prompt)
    const decodedFirst = decode(parseJsonObject(first))
    if (decodedFirst !== null) return decodedFirst

    const repaired = await repairStructuredOutput({
      modelClient: this.options.modelClient,
      abortSignal: this.options.abortSignal,
      prompt,
      invalidOutput: first
    })
    const decodedRepair = decode(parseJsonObject(repaired.output))
    if (decodedRepair !== null) return decodedRepair

    const reason = repaired.finishReason === 'length'
      ? '结构化输出被模型长度上限截断'
      : '结构化结果无法通过 JSON 与字段校验'
    throw new Error(
      `XForge ${this.options.getStage()} 阶段${reason}: ${repaired.output.slice(0, 240)}`
    )
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

async function repairStructuredOutput(params: {
  modelClient: ModelClient | ModelClientPool
  abortSignal?: AbortSignal
  prompt: string
  invalidOutput: string
}): Promise<{ output: string; finishReason: string }> {
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: [
        '你是 XForge 的结构化结果修复器。你没有工具，不要分析过程。',
        '根据原始任务和不合格输出，重新生成原始任务要求的单个紧凑 JSON 对象。',
        '不要使用 Markdown 围栏，不要返回原始任务未要求的说明或 Markdown 字段。'
      ].join('\n')
    },
    { role: 'user', content: params.prompt },
    { role: 'assistant', content: params.invalidOutput.slice(0, 16_000) },
    {
      role: 'user',
      content: '上面的输出无法通过结构校验。现在只返回修正后的一个合法 JSON 对象。'
    }
  ]
  let output = ''
  let finishReason = ''
  for await (const event of params.modelClient.chat(messages, undefined, {
    abortSignal: params.abortSignal
  })) {
    if (event.type === 'text_delta') output += event.delta
    if (event.type === 'message_end') finishReason = event.finishReason
    if (event.type === 'error') throw new Error(event.error)
    if (event.type === 'context_overflow') throw new Error(event.rawError)
    if (event.type === 'cancelled') throw new Error('XForge 结构化结果修复已取消')
  }
  if (!output.trim()) throw new Error('XForge 结构化结果修复返回空结果')
  return { output: output.trim(), finishReason }
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
    useUnifiedSkillDispatch: false
  })
  loop.setMode('plan')
  const onAbort = () => loop.cancel()
  options.abortSignal?.addEventListener('abort', onAbort)
  try {
    const reviewPrompt = [
      '请审查下面的 XForge Review Input Snapshot。',
      '只返回 JSON：{"findings":[{"severity":"critical|high|medium|low|nit","location":"file:line","summary":"...","evidence":"...","suggestion":"...","unverified":false}]}。没有问题时 findings 为空数组。',
      JSON.stringify(input)
    ].join('\n\n')
    await loop.sendMessage(reviewPrompt)
    throwIfAborted(options.abortSignal)
    let parsed = parseJsonObject(output) as { findings?: unknown } | null
    let findings = parsed && isReviewFindings(parsed.findings) ? parsed.findings : null
    if (!findings) {
      const repaired = await repairStructuredOutput({
        modelClient: options.modelClient,
        abortSignal: options.abortSignal,
        prompt: reviewPrompt,
        invalidOutput: output
      })
      parsed = parseJsonObject(repaired.output) as { findings?: unknown } | null
      findings = parsed && isReviewFindings(parsed.findings) ? parsed.findings : null
      if (!findings) {
        const reason = repaired.finishReason === 'length' ? '输出被长度上限截断' : '字段校验失败'
        throw new Error(`隔离 Review 子代理返回了无效 findings：${reason}`)
      }
    }
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
  const reviewOnly =
    /(只|仅).{0,8}(审查|review|检查|看看)|不要(改|动|修改)(代码|文件)?|禁止修改|别(改|动)(代码|文件)?/i.test(text)
  const codeReadyForTest = /(已经|已).{0,10}(改好|完成|实现).{0,12}(测试|检查|验证)|从测试开始/i.test(text)
  const isBugfix = /(修复|bug|报错|故障|崩溃|异常|卡顿|很卡|加载慢|加载.*卡|性能问题)/i.test(text) && !codeReadyForTest
  const hasDesignOnlyDoc = /(?:\.md\b|设计文档|方案文档|需求文档)/i.test(text)
  const requestedStartStage = parseRequestedStage(text)
  const vague = /(还没想清楚|不确定|想做|我想|我打算|帮我想|探索一下|需求模糊|你觉得|有什么建议|怎么看)/i.test(text)
  return {
    reviewOnly,
    codeReadyForTest,
    isBugfix,
    hasDesignOnlyDoc,
    isVagueNewRequirement: vague,
    ...(requestedStartStage ? { requestedStartStage } : {})
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

function isResolverSemanticPayload(value: unknown): value is ResolverSemanticPayload {
  return isRecord(value) &&
    typeof value.reviewOnly === 'boolean' &&
    typeof value.codeReadyForTest === 'boolean' &&
    typeof value.isBugfix === 'boolean' &&
    typeof value.isVagueNewRequirement === 'boolean' &&
    typeof value.isNonDevRequest === 'boolean' &&
    (value.modelSemanticHint === 'brainstorm' || value.modelSemanticHint === 'plan')
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
  const needsMoreClarification = typeof value.needsMoreClarification === 'boolean'
    ? value.needsMoreClarification
    : legacyBody !== null
      ? false
      : null
  if (needsMoreClarification === null) return null

  const suppliedSession = parseMainSession(value.mainSession) ?? fallbackSession
  const designNotes = isStringArray(value.designNotes)
    ? value.designNotes
    : legacyBody?.trim()
      ? [legacyBody.trim()]
      : []

  return {
    needsMoreClarification,
    mainSession: {
      goal: suppliedSession.goal,
      constraints: [...suppliedSession.constraints],
      nonGoals: [...suppliedSession.nonGoals],
      userDecisions: [...suppliedSession.userDecisions]
    },
    designNotes
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
  return isRecord(value) && isRecord(value.plan)
}

function isScopePayload(value: unknown): value is ScopePayload {
  return isRecord(value) && Array.isArray(value.findings) &&
    value.findings.every(isScopeFinding)
}

function isScopeFinding(value: unknown): value is XForgeScopeFindingState {
  return isRecord(value) && ['critical', 'high', 'medium', 'low'].includes(String(value.severity)) &&
    typeof value.location === 'string' && typeof value.summary === 'string' &&
    typeof value.evidence === 'string' && typeof value.suggestion === 'string'
}

function isFixPayload(value: unknown): value is FixPayload {
  return isRecord(value) && typeof value.expandsScope === 'boolean'
}

function isReviewFindings(value: unknown): value is XForgeReviewFindingState[] {
  return Array.isArray(value) && value.every(finding =>
    isRecord(finding) && ['critical', 'high', 'medium', 'low', 'nit'].includes(String(finding.severity)) &&
    typeof finding.location === 'string' && typeof finding.summary === 'string' &&
    typeof finding.evidence === 'string'
  )
}

function renderBrainstormArtifact(payload: BrainstormPayload): string {
  const { mainSession } = payload
  return [
    '# XForge Exploration',
    '',
    '## Goal',
    '',
    mainSession.goal || '未明确',
    '',
    '## Constraints',
    '',
    ...renderMarkdownList(mainSession.constraints),
    '',
    '## Non-goals',
    '',
    ...renderMarkdownList(mainSession.nonGoals),
    '',
    '## User decisions',
    '',
    ...renderMarkdownList(mainSession.userDecisions),
    '',
    '## Design notes',
    '',
    ...renderMarkdownList(payload.designNotes)
  ].join('\n')
}

function renderPlanArtifact(plan: XForgeValidatedPlan): string {
  const validation = validateXForgePlan(plan)
  if (!validation.valid) {
    return [
      '# XForge Implementation Plan',
      '',
      `Validated Plan 缺少必需字段: ${validation.missing.join(', ')}`
    ].join('\n')
  }
  return [
    '# XForge Implementation Plan',
    '',
    '## Goal',
    '',
    plan.goal,
    '',
    '## Constraints',
    '',
    ...renderMarkdownList(plan.constraints),
    '',
    '## Non-goals',
    '',
    ...renderMarkdownList(plan.nonGoals),
    '',
    '## Repository facts',
    '',
    ...renderMarkdownList(plan.repositoryFacts),
    '',
    '## Change scope',
    '',
    ...renderMarkdownList(plan.changeScope),
    '',
    '## Tasks',
    '',
    ...plan.tasks.flatMap(task => [
      `### ${task.id}: ${task.title}`,
      '',
      ...renderMarkdownList(task.acceptance),
      ''
    ]),
    '## Verification',
    '',
    ...renderMarkdownList(plan.verificationChecklist),
    '',
    '## Risks',
    '',
    ...renderMarkdownList(plan.risks)
  ].join('\n')
}

function renderScopeArtifact(findings: XForgeScopeFindingState[]): string {
  return [
    '# XForge Scope Check',
    '',
    ...(findings.length === 0
      ? ['PASS']
      : findings.flatMap(finding => [
          `## [${finding.severity}] ${finding.location}`,
          '',
          finding.summary,
          '',
          `Evidence: ${finding.evidence}`,
          '',
          `Suggestion: ${finding.suggestion}`,
          ''
        ]))
  ].join('\n')
}

function renderFixArtifact(params: {
  expandsScope: boolean
  failedTest: XForgeRunState['testEvidence']
  blockingFindings: XForgeReviewFindingState[]
  fileEffects: Array<{ path: string; status?: string }>
}): string {
  const failedCommands = params.failedTest?.commands
    .filter(command => command.required && (command.exitCode !== 0 || command.timedOut || command.blockedReason))
    .map(command => `${command.command}: ${command.blockedReason ?? (command.timedOut ? 'timeout' : `exitCode=${command.exitCode}`)}`) ?? []
  return [
    '# XForge Fix Evidence',
    '',
    `Expands scope: ${params.expandsScope ? 'yes' : 'no'}`,
    '',
    '## Failed verification',
    '',
    ...renderMarkdownList(failedCommands),
    '',
    '## Blocking findings',
    '',
    ...renderMarkdownList(params.blockingFindings.map(finding =>
      `[${finding.severity}] ${finding.location}: ${finding.summary}`
    )),
    '',
    '## Recorded file effects',
    '',
    ...renderMarkdownList(params.fileEffects.map(effect => `${effect.status ?? 'unknown'}: ${effect.path}`))
  ].join('\n')
}

function renderMarkdownList(items: string[]): string[] {
  if (items.length === 0) return ['- None']
  return items.map(item => `- ${item.replace(/\r?\n/g, '\n  ')}`)
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

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('XForge 执行已取消')
}

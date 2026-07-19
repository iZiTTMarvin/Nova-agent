import { randomUUID } from 'crypto'
import type { AskQuestionAnswer, AskQuestionItem } from '../../../shared/askQuestion/types'
import type { CheckpointManager } from '../../checkpoints/CheckpointManager'
import type { XForgeMainAgentSession } from './mainAgentSession'
import { throwIfAborted } from './mainAgentSession'
import type { XForgeControlledTestCommand } from './deliveryExecutor'
import { stagePrompt, renderMarkdownList } from './liveHostPrompt'
import type { XForgeLiveHostRuntime } from './liveHostRuntime'
import type {
  XForgeRunCommitter,
  XForgeMainSessionState,
  XForgeRunState,
  XForgeScopeFindingState,
  XForgeTaskState
} from './runState'
import {
  createWorkspaceFingerprint,
  writeXForgeArtifact,
  writeXForgeEvidence
} from './stageArtifacts'
import type { XForgeStageHost } from './stageExecutor'
import { inspectXForgeTaskEffects, prepareXForgeWriteBoundary } from './writeSafety'
import { runXForgeControlledTestCommand } from './deliveryRuntime'
import { validateXForgePlan, type XForgeValidatedPlan } from './plan'

export interface XForgeLiveStageHostDeps {
  session: XForgeMainAgentSession
  runtime: XForgeLiveHostRuntime
  options: {
    runId: string
    request: string
    workspaceRoot: string
    abortSignal?: AbortSignal
    checkpointManager: CheckpointManager
    committer: XForgeRunCommitter
    askQuestion: (requestId: string, questions: AskQuestionItem[]) => Promise<AskQuestionAnswer[]>
  }
  resolveTaskVerificationCommand: (
    state: XForgeRunState,
    task: XForgeTaskState
  ) => XForgeControlledTestCommand | null
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

/** 装配 brainstorm/plan/scope/implement 的外部能力适配器。 */
export function createXForgeLiveStageHost(deps: XForgeLiveStageHostDeps): XForgeStageHost {
  const { options, session, runtime, resolveTaskVerificationCommand } = deps
  return {
    activateStage: async (params) => {
      throwIfAborted(options.abortSignal)
      runtime.activeStage = params.stage
      runtime.activeSkillBody = params.skill?.body ?? ''
    },
    askQuestion: async ({ questions }) => {
      throwIfAborted(options.abortSignal)
      return options.askQuestion(randomUUID(), questions)
    },
    buildExplorationQuestions: async ({ method, round, context }) => {
      const payload = await session.runJson<ExplorationQuestionsPayload>(stagePrompt(
        runtime.activeSkillBody,
        '需求澄清',
        options.request,
        { method, round, context },
        '根据用户目标和已知决策生成 1 到 3 条必须由用户回答的具体问题。问题要消除目标、约束、验收或不可触碰边界中的真实未知；不要使用泛化的“继续”问题。只返回 JSON：{"questions":[{"question":"...","options":[{"label":"...","description":"..."}],"custom":true}]}。'
      ), isExplorationQuestionsPayload)
      return payload.questions
    },
    runBrainstorm: async ({ method, round, answers, context }) => {
      const payload = await session.runJsonDecoded<BrainstormPayload>(stagePrompt(
        runtime.activeSkillBody,
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
        runtime.activeSkillBody,
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
        runtime.activeSkillBody,
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
      runtime.activeStepId = task.id
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
      const command = resolveTaskVerificationCommand(current, task)
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

export function renderPlanArtifact(plan: XForgeValidatedPlan): string {
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

function renderTaskSummary(tasks: XForgeTaskState[]): string {
  return ['# Implementation Summary', '', ...tasks.map(task =>
    `- ${task.id} ${task.title}: ${task.status}${task.failureReason ? ` — ${task.failureReason}` : ''}`
  )].join('\n')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

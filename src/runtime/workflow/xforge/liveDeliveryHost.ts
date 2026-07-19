import { randomUUID } from 'crypto'
import type { AskQuestionAnswer, AskQuestionItem } from '../../../shared/askQuestion/types'
import type { ModelClient } from '../../model/ModelClient'
import type { ModelClientPool } from '../../model/ModelClientPool'
import { AgentLoop } from '../../agent/AgentLoop'
import { EventBus } from '../../agent/EventBus'
import type { CheckpointManager } from '../../checkpoints/CheckpointManager'
import type { SkillRegistry } from '../../skills/SkillRegistry'
import {
  parseJsonObject,
  repairStructuredOutput,
  throwIfAborted,
  type XForgeMainAgentSession
} from './mainAgentSession'
import type {
  XForgeControlledTestCommand,
  XForgeDeliveryHost,
  XForgeReviewInputSnapshot
} from './deliveryExecutor'
import {
  captureXForgeWorkspaceFingerprint,
  createXForgeReviewSnapshot,
  recordXForgeTestEvidence,
  resolveXForgeVerificationTimeout,
  runXForgeControlledTestCommand,
  writeXForgeRuntimeReport
} from './deliveryRuntime'
import { stagePrompt, renderMarkdownList } from './liveHostPrompt'
import type { XForgeLiveHostRuntime } from './liveHostRuntime'
import { isSafeRuntimeTestCommand } from './policy'
import type {
  XForgeReviewFindingState,
  XForgeRunCommitter,
  XForgeRunState,
  XForgeTaskState
} from './runState'
import { buildMainAgentContext } from './stageExecutor'
import {
  createWorkspaceFingerprint,
  writeXForgeArtifact,
  writeXForgeEvidence
} from './stageArtifacts'
import { inspectXForgeTaskEffects, prepareXForgeWriteBoundary } from './writeSafety'

export interface XForgeLiveDeliveryHostDeps {
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
    modelClient: ModelClient | ModelClientPool
    skillRegistry: SkillRegistry
    contextWindow?: number
  }
}

interface FixPayload {
  expandsScope: boolean
}

/** 装配 test/review/fix/report 的外部能力适配器。 */
export function createXForgeLiveDeliveryHost(deps: XForgeLiveDeliveryHostDeps): XForgeDeliveryHost {
  const { options, session, runtime } = deps
  return {
    activateStage: async (params) => {
      throwIfAborted(options.abortSignal)
      runtime.activeStage = params.stage
      runtime.activeSkillBody = params.skill?.body ?? ''
    },
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
    createReviewSnapshot: async ({ state }) =>
      createXForgeReviewSnapshot({
        workspaceRoot: options.workspaceRoot,
        runId: options.runId,
        baseline: state.workspaceBaseline,
        reviewTarget: state.reviewTarget,
        changeScope: state.validatedPlan?.changeScope ?? null
      }),
    runReviewSubagent: async ({ input }) => {
      const reviewSkill = options.skillRegistry.get('br-review')
      if (!reviewSkill || reviewSkill.invalid || !reviewSkill.enabled || !reviewSkill.body.trim()) {
        throw new Error('隔离 Review 子代理所需方法 br-review 缺失或无效')
      }
      return runIsolatedReview(options, input, reviewSkill.body)
    },
    prepareWriteBoundary: async ({ checkpointRef, workspaceRevision }) =>
      prepareXForgeWriteBoundary({
        checkpointManager: options.checkpointManager,
        workspaceRoot: options.workspaceRoot,
        checkpointRef,
        workspaceRevision
      }),
    runFix: async ({ state, failedTest, blockingFindings }) => {
      runtime.activeStepId = `fix-${state.deliveryTestFixUsed}-${state.reviewRemediationUsed}`
      const payload = await session.runJson<FixPayload>(stagePrompt(
        runtime.activeSkillBody,
        '根因修复',
        options.request,
        { failedTest, blockingFindings, state: buildMainAgentContext(state) },
        '先定位根因，再使用工具完成最小且完整的修复。不要运行验证命令。只返回 JSON：{"expandsScope":false}。不要返回 Markdown；若修复超出当前计划 changeScope，expandsScope 必须为 true。'
      ), isFixPayload)
      const inspection = inspectXForgeTaskEffects({
        workspaceRoot: options.workspaceRoot,
        runId: options.runId,
        taskId: runtime.activeStepId
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
          name: runtime.activeStepId,
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
}

async function runIsolatedReview(
  options: {
    runId: string
    workspaceRoot: string
    modelClient: ModelClient | ModelClientPool
    abortSignal?: AbortSignal
    contextWindow?: number
  },
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

function renderReviewFindings(findings: XForgeReviewFindingState[]): string {
  return ['# Review Findings', '', ...(findings.length === 0
    ? ['No findings.']
    : findings.map(finding => `- [${finding.severity}] ${finding.location}: ${finding.summary}\n  - Evidence: ${finding.evidence}`)
  )].join('\n')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

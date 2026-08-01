import type { WorkflowDefinition, WorkflowResult } from '../types'
import { runBrainstorm, normalizeBrainstorm } from './brainstorm'
import { runImplement } from './implement'
import { normalizeWorkflowPlan, runPlan } from './plan'
import { runReport } from './report'
import { runReview } from './review'
import { runVerify } from './verify'
import type {
  ActivePlanDocument,
  BrainstormResult,
  ComposeReportInput
} from './types'

export const COMPOSE_STAGES = [
  'brainstorm',
  'plan',
  'implement',
  'verify',
  'review',
  'report'
] as const

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function readActivePlan(injectedContext: Record<string, unknown>): ActivePlanDocument | undefined {
  const direct = injectedContext.activePlanMarkdown
  if (typeof direct === 'string' && direct.trim()) {
    return { content: direct }
  }

  const raw = injectedContext.activePlan
  if (typeof raw === 'string' && raw.trim()) return { content: raw }
  const record = asRecord(raw)
  if (!record || typeof record.content !== 'string' || !record.content.trim()) return undefined
  return {
    content: record.content,
    ...(typeof record.path === 'string' && record.path.trim() ? { path: record.path } : {}),
    ...(typeof record.title === 'string' && record.title.trim() ? { title: record.title } : {})
  }
}

function cancelled(ctx: { abortSignal: AbortSignal }): WorkflowResult | null {
  return ctx.abortSignal.aborted ? { status: 'failed', reason: 'workflow cancelled' } : null
}

export const composeWorkflow: WorkflowDefinition = {
  name: 'compose',
  description:
    '从需求分析、结构化计划、隔离实现到验证审查和最终摘要的完整开发流程。' +
    'startStage 是进入点：brainstorm 先做方案对比（默认）；plan 跳过方案对比直接制定计划；' +
    'implement 及以后阶段进入时，需已有 plan（injectedContext 或会话 active plan），缺失时会回补 plan 阶段。',
  matchHints: ['复杂开发任务', '多阶段实现', '需要计划、实现、验证和审查'],
  stages: [...COMPOSE_STAGES],
  async run(ctx): Promise<WorkflowResult> {
    const earlyCancel = cancelled(ctx)
    if (earlyCancel) return earlyCancel

    const injectedPlan = normalizeWorkflowPlan(ctx.injectedContext.plan, ctx.request)
    const activePlan = readActivePlan(ctx.injectedContext)
    let brainstorm: BrainstormResult | null = normalizeBrainstorm(ctx.injectedContext.brainstorm ?? null)
    let plan = injectedPlan

    // startStage 是显式进入点：只有从 brainstorm 起跑才做方案对比。
    // 从 plan 起跑却静默拖回 brainstorm，会让调用方无法把「brainstorm failed」
    // 与自己的调用对应起来（plan 阶段本就能在 brainstorm=null 下工作）。
    const mustBrainstorm = ctx.startStage === 'brainstorm'
    if (mustBrainstorm) {
      brainstorm = await runBrainstorm(ctx.host, ctx.request, ctx.autoMode)
      if (!brainstorm) {
        return {
          status: 'failed',
          reason:
            'brainstorm 阶段未产出有效方案（模型输出无法解析或子代理异常，详见 .nova/workflow/runs 对应 run 的 log.txt）。' +
            '可直接重试，或以 startStage=plan 重新调用 start_workflow 跳过方案构思'
        }
      }
    }

    const mustPlan = ctx.startStage === 'brainstorm' || ctx.startStage === 'plan' || !plan
    if (mustPlan) {
      plan = await runPlan(ctx.host, ctx.request, brainstorm, ctx.autoMode, activePlan)
      if (!plan) return { status: 'failed', reason: 'plan failed' }
    }
    if (!plan) return { status: 'failed', reason: '缺少可执行 WorkflowPlan' }

    const cancelBeforeImplement = cancelled(ctx)
    if (cancelBeforeImplement) return cancelBeforeImplement
    const implement = await runImplement(ctx.host, plan, brainstorm)
    if (implement.status === 'failed') {
      return { status: 'failed', reason: implement.fatalReason ?? 'implement failed' }
    }

    const cancelBeforeVerify = cancelled(ctx)
    if (cancelBeforeVerify) return cancelBeforeVerify
    const verify = await runVerify(ctx.host)
    if (!verify) return { status: 'failed', reason: 'verify failed' }

    const cancelBeforeReview = cancelled(ctx)
    if (cancelBeforeReview) return cancelBeforeReview
    const review = await runReview(ctx.host, plan, implement, verify)
    if (!review) return { status: 'failed', reason: 'review failed' }

    const cancelBeforeReport = cancelled(ctx)
    if (cancelBeforeReport) return cancelBeforeReport
    const reportInput: ComposeReportInput = {
      request: ctx.request,
      plan,
      brainstorm,
      implement,
      verify,
      review
    }
    const report = await runReport(ctx.host, reportInput)
    if (!report) return { status: 'failed', reason: 'report failed' }

    return {
      status: 'completed',
      summary: report.summary,
      result: {
        outcome: report.outcome,
        brainstorm,
        plan,
        implement,
        verify,
        review,
        report
      }
    }
  }
}

export { runBrainstorm } from './brainstorm'
export { runPlan, normalizeWorkflowPlan } from './plan'
export { runImplement } from './implement'
export { runVerify, VERIFY_COMMANDS } from './verify'
export { runReview } from './review'
export { runReport } from './report'
export type {
  ActivePlanDocument,
  BrainstormAlternative,
  BrainstormResult,
  ImplementResult,
  ImplementTaskResult,
  ReportResult,
  ReviewIssue,
  ReviewResult,
  VerifyResult,
  VerificationCheck
} from './types'

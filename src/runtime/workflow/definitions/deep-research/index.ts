/**
 * deep-research workflow：brief → research（并行）→ synthesize → review。
 *
 * 与 compose 的两个刻意差异：
 * 1. 没有 report 阶段。最终摘要由本文件按结构化结果拼装，不再多花一次模型调用——
 *    synthesize 的产出本身就是给用户看的交付物，让另一个 agent 复述它没有信息增量。
 * 2. stages 只暴露 brief。stages 的语义是"允许的起始阶段"，而 research 之后的每个阶段
 *    都以前一阶段的结构化产出为输入，没有任何外部产物能充当入口，
 *    因此从中途进入不可能成立，不给模型这个选项。
 */
import type { WorkflowDefinition, WorkflowResult } from '../types'
import { runBrief } from './brief'
import { runResearch } from './research'
import { runSynthesize } from './synthesize'
import { runResearchReview } from './review'
import type { DeepResearchOutcome, ResearchReviewResult, ResearchSynthesis } from './types'

export const DEEP_RESEARCH_ENTRY_STAGES = ['brief'] as const

/** 取消检查放在每次阶段切换前：阶段内部的中断由 host.agent 返回 null 自然表达 */
function cancelled(ctx: { abortSignal: AbortSignal }): WorkflowResult | null {
  return ctx.abortSignal.aborted ? { status: 'failed', reason: 'workflow cancelled' } : null
}

/** 交付摘要：结论优先，其次是待办性质的信息（冲突、未解决、复核问题） */
function buildSummary(synthesis: ResearchSynthesis, review: ResearchReviewResult): string {
  const lines = [synthesis.conclusion]
  if (synthesis.keyPoints.length > 0) {
    lines.push('', '要点：', ...synthesis.keyPoints.map((point) => `- ${point}`))
  }
  if (synthesis.conflicts.length > 0) {
    lines.push('', '证据冲突：', ...synthesis.conflicts.map((conflict) => `- ${conflict}`))
  }
  if (synthesis.unresolved.length > 0) {
    lines.push('', '未解决：', ...synthesis.unresolved.map((item) => `- ${item}`))
  }
  if (synthesis.recommendations.length > 0) {
    lines.push('', '建议：', ...synthesis.recommendations.map((item) => `- ${item}`))
  }
  if (synthesis.citations.length > 0) {
    lines.push('', '来源：', ...synthesis.citations.map((source) => `- ${source}`))
  }
  lines.push('', `复核结论：${review.verdict}——${review.summary}`)
  if (review.issues.length > 0) {
    lines.push(...review.issues.map((issue) => `- [${issue.severity}] ${issue.summary}`))
  }
  return lines.join('\n')
}

export const deepResearchWorkflow: WorkflowDefinition = {
  name: 'deep-research',
  description:
    '把一个研究问题拆成子问题后并行只读检索，再综合成带来源引用的结论并复核证据是否充分。产出结论，不修改代码。',
  matchHints: ['调研某个主题', '研究技术选型或方案对比', '查清事实并给出带来源的结论', '不需要改动代码'],
  stages: [...DEEP_RESEARCH_ENTRY_STAGES],
  async run(ctx): Promise<WorkflowResult> {
    const earlyCancel = cancelled(ctx)
    if (earlyCancel) return earlyCancel

    const brief = await runBrief(ctx.host, ctx.request, ctx.autoMode)
    if (!brief) return { status: 'failed', reason: 'brief failed' }

    const cancelBeforeResearch = cancelled(ctx)
    if (cancelBeforeResearch) return cancelBeforeResearch
    const findings = await runResearch(ctx.host, brief)
    if (!findings) return { status: 'failed', reason: 'research failed' }

    const cancelBeforeSynthesize = cancelled(ctx)
    if (cancelBeforeSynthesize) return cancelBeforeSynthesize
    const synthesis = await runSynthesize(ctx.host, brief, findings)
    if (!synthesis) return { status: 'failed', reason: 'synthesize failed' }

    const cancelBeforeReview = cancelled(ctx)
    if (cancelBeforeReview) return cancelBeforeReview
    const review = await runResearchReview(ctx.host, brief, findings, synthesis)
    if (!review) return { status: 'failed', reason: 'review failed' }

    const outcome: DeepResearchOutcome = { brief, findings, synthesis, review }
    return {
      status: 'completed',
      summary: buildSummary(synthesis, review),
      result: outcome
    }
  }
}

export { runBrief, normalizeBrief, BRIEF_SCHEMA } from './brief'
export { runResearch, normalizeFinding, FINDING_SCHEMA } from './research'
export { runSynthesize, normalizeSynthesis, SYNTHESIS_SCHEMA } from './synthesize'
export {
  runResearchReview,
  normalizeResearchReview,
  findMissingSubQuestionIds,
  RESEARCH_REVIEW_SCHEMA
} from './review'
export type {
  DeepResearchOutcome,
  ResearchBrief,
  ResearchEvidence,
  ResearchFinding,
  ResearchFindings,
  ResearchReviewIssue,
  ResearchReviewResult,
  ResearchReviewVerdict,
  ResearchSubQuestion,
  ResearchSynthesis
} from './types'

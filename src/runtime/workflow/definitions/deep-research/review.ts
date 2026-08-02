/**
 * review 阶段：对综合结论做只读复核。
 *
 * 复核对象是"结论与证据是否匹配"，不是代码质量——所以它和 compose 的 review
 * 是两个不同的审查概念，各自持有自己的判据与结果形状。
 *
 * missingSubQuestionIds 和 unsupportedClaims 由本阶段在代码里先算出确定部分，
 * 再交给 agent 补充判断：能机械核对的事实不依赖模型自觉。
 */
import type { AgentResult, HostFns } from '../../host'
import { asEnum, asRecord, asString, asStringList } from '../agentOutput'
import type {
  ResearchBrief,
  ResearchFindings,
  ResearchReviewIssue,
  ResearchReviewResult,
  ResearchSynthesis
} from './types'

const VERDICTS = ['pass', 'conditional', 'block'] as const
const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const

export const RESEARCH_REVIEW_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: [...VERDICTS] },
    summary: { type: 'string' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: [...SEVERITIES] },
          summary: { type: 'string' },
          suggestion: { type: 'string' }
        },
        required: ['severity', 'summary']
      }
    },
    unsupportedClaims: { type: 'array', items: { type: 'string' } }
  },
  required: ['verdict', 'summary', 'issues']
}

/** 机械核对：brief 里有、但没有任何可用 finding 覆盖的子问题 */
export function findMissingSubQuestionIds(
  brief: ResearchBrief,
  findings: ResearchFindings
): string[] {
  const covered = new Set([...findings.answeredIds, ...findings.inconclusiveIds])
  return brief.subQuestions
    .map((subQuestion) => subQuestion.id)
    .filter((id) => !covered.has(id))
}

function normalizeIssue(value: unknown): ResearchReviewIssue | null {
  const record = asRecord(value)
  if (!record) return null
  const severity = asEnum(record.severity, SEVERITIES)
  const summary = asString(record.summary) ?? asString(record.description)
  if (!severity || !summary) return null
  const suggestion = asString(record.suggestion)
  return { severity, summary, ...(suggestion ? { suggestion } : {}) }
}

/**
 * 归一化审查结论。
 *
 * 结论没有任何来源引用是硬失败条件：这种情况即使模型给了 pass 也强制降级为 block，
 * 因为无法追溯的调研结论对用户没有价值。
 */
export function normalizeResearchReview(
  value: AgentResult,
  brief: ResearchBrief,
  findings: ResearchFindings,
  synthesis: ResearchSynthesis
): ResearchReviewResult | null {
  const record = asRecord(value)
  if (!record) return null
  const claimedVerdict = asEnum(record.verdict, VERDICTS)
  if (!claimedVerdict) return null

  const issues = (Array.isArray(record.issues) ? record.issues : [])
    .map(normalizeIssue)
    .filter((issue): issue is ResearchReviewIssue => issue !== null)
  const missingSubQuestionIds = findMissingSubQuestionIds(brief, findings)
  const noCitations = synthesis.citations.length === 0

  const verdict = noCitations
    ? 'block'
    : claimedVerdict === 'pass' && missingSubQuestionIds.length > 0
      ? 'conditional'
      : claimedVerdict

  return {
    verdict,
    summary: asString(record.summary) ?? '结论复核完成。',
    issues: noCitations
      ? [
          {
            severity: 'critical',
            summary: '结论没有任何可追溯来源',
            suggestion: '补充检索或明确声明结论不成立'
          },
          ...issues
        ]
      : issues,
    missingSubQuestionIds,
    unsupportedClaims: asStringList(record.unsupportedClaims ?? record.unsupported)
  }
}

function buildPrompt(
  brief: ResearchBrief,
  findings: ResearchFindings,
  synthesis: ResearchSynthesis
): string {
  return [
    '你负责 deep-research workflow 的 review 阶段。',
    '只读复核，不修改文件，不向用户提问，不补充新的检索。',
    '按四条判据审查：结论是否直接回答主研究问题；每条关键结论是否有 findings 中的证据支撑；',
    '证据冲突是否被如实暴露；完成判据是否满足。',
    '把缺少证据支撑的结论表述逐条写入 unsupportedClaims。',
    '必须返回 JSON：verdict（pass/conditional/block）、summary、issues、unsupportedClaims。',
    '',
    `主研究问题：${brief.question}`,
    `完成判据：${brief.successCriteria.join('；')}`,
    `检索结果：\n${JSON.stringify(findings.findings)}`,
    `综合结论：\n${JSON.stringify(synthesis)}`
  ].join('\n')
}

export async function runResearchReview(
  host: HostFns,
  brief: ResearchBrief,
  findings: ResearchFindings,
  synthesis: ResearchSynthesis
): Promise<ResearchReviewResult | null> {
  host.progress('review', 'started')
  let output: AgentResult = null
  try {
    output = await host.agent(buildPrompt(brief, findings, synthesis), {
      taskId: 'review',
      phase: 'review',
      isolation: 'readonly',
      interactive: false,
      schema: RESEARCH_REVIEW_SCHEMA,
      label: 'deep-research-review'
    })
  } catch {
    output = null
  }

  const review = normalizeResearchReview(output, brief, findings, synthesis)
  if (!review) {
    host.progress('review', 'failed', { message: 'review 未产出结构化复核结论' })
    return null
  }
  host.progress('review', review.verdict === 'block' ? 'failed' : 'completed', {
    message: `${review.verdict}：问题 ${review.issues.length} 项，未覆盖子问题 ${review.missingSubQuestionIds.length} 个`
  })
  return review
}

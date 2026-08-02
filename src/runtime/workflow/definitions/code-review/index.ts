/**
 * code-review workflow：收集 git 变更面 → 只读审查 → 交付结论。
 *
 * 单阶段设计。它存在的理由是"我改完了帮我审一遍"这个场景不需要 brainstorm / plan /
 * implement——用 compose 跑等于让三个阶段空转。审查本身是只读的，
 * 因此全程不创建 worktree、不写工作区、不向用户提问。
 */
import type { AgentResult, HostFns } from '../../host'
import { asEnum, asRecord, asString, asStringList } from '../agentOutput'
import type { WorkflowDefinition, WorkflowResult } from '../types'
import { collectCodeReviewScope } from './scope'
import type {
  CodeReviewFinding,
  CodeReviewOutcome,
  CodeReviewResult,
  CodeReviewScope
} from './types'

export const CODE_REVIEW_ENTRY_STAGES = ['review'] as const

const VERDICTS = ['pass', 'conditional', 'block'] as const
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'nit'] as const

export const CODE_REVIEW_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: [...VERDICTS] },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: [...SEVERITIES] },
          file: { type: 'string' },
          line: { type: 'number' },
          summary: { type: 'string' },
          suggestion: { type: 'string' }
        },
        required: ['severity', 'summary']
      }
    },
    strengths: { type: 'array', items: { type: 'string' } },
    unverified: { type: 'array', items: { type: 'string' } }
  },
  required: ['verdict', 'summary', 'findings']
}

function normalizeFinding(value: unknown): CodeReviewFinding | null {
  const record = asRecord(value)
  if (!record) return null
  const severity = asEnum(record.severity, SEVERITIES)
  const summary = asString(record.summary) ?? asString(record.description)
  if (!severity || !summary) return null
  const file = asString(record.file) ?? asString(record.path)
  const line = typeof record.line === 'number' && Number.isInteger(record.line) ? record.line : undefined
  const suggestion = asString(record.suggestion)
  return {
    severity,
    ...(file ? { file } : {}),
    ...(line !== undefined ? { line } : {}),
    summary,
    ...(suggestion ? { suggestion } : {})
  }
}

/**
 * 归一化审查结论。
 *
 * verdict 不完全采信模型：存在 critical 问题却给 pass 是模型常见的自相矛盾，
 * 这里以问题清单为准强制降级，避免用户看到"通过"却下面列着阻塞项。
 */
export function normalizeCodeReview(value: AgentResult): CodeReviewResult | null {
  const record = asRecord(value)
  if (!record) return null
  const claimedVerdict = asEnum(record.verdict, VERDICTS)
  if (!claimedVerdict) return null

  const rawFindings = Array.isArray(record.findings)
    ? record.findings
    : Array.isArray(record.issues)
      ? record.issues
      : []
  const findings = rawFindings
    .map(normalizeFinding)
    .filter((finding): finding is CodeReviewFinding => finding !== null)
  const criticalCount = findings.filter((finding) => finding.severity === 'critical').length
  const highCount = findings.filter((finding) => finding.severity === 'high').length

  const verdict =
    criticalCount > 0
      ? 'block'
      : claimedVerdict === 'pass' && highCount > 0
        ? 'conditional'
        : claimedVerdict

  return {
    verdict,
    summary: asString(record.summary) ?? '代码审查完成。',
    findings,
    strengths: asStringList(record.strengths),
    unverified: asStringList(record.unverified ?? record.uncertainties),
    criticalCount,
    highCount
  }
}

function buildPrompt(request: string, scope: CodeReviewScope): string {
  return [
    '你负责 code-review workflow 的 review 阶段。',
    '先读项目规则（AGENTS.md 及目录级规则）和被改动文件的相邻代码，再以真实代码为证据审查。',
    '审查维度：正确性、边界与失败路径、范围是否超出意图、架构与依赖方向、契约与类型、安全、测试是否覆盖新行为。',
    '只读审查：不修改文件，不执行命令，不向用户提问。无法验证的点写入 unverified，不要臆断。',
    '每个问题都要指出文件与行号，并给出可执行的修改建议。',
    '必须返回 JSON：verdict（pass/conditional/block）、summary、findings、strengths、unverified。',
    '',
    `用户诉求：${request}`,
    `审查范围：${scope.origin === 'working-tree' ? '工作区未提交改动' : '最近一次提交'}（基线 ${scope.baseRef}）`,
    `变更文件：${scope.changedFiles.join('、') || '无'}`,
    ...(scope.untrackedFiles.length > 0
      ? [`未跟踪的新文件（不在 diff 中，需自行读取）：${scope.untrackedFiles.join('、')}`]
      : []),
    `变更统计：\n${scope.diffStat || '无'}`,
    ...(scope.truncated ? ['注意：下面的 diff 已被截断，请用只读工具补读完整文件。'] : []),
    `Diff：\n${scope.diff || '无'}`
  ].join('\n')
}

export async function runCodeReview(
  host: HostFns,
  request: string,
  scope: CodeReviewScope
): Promise<CodeReviewResult | null> {
  host.progress('review', 'started', {
    message: `审查 ${scope.changedFiles.length + scope.untrackedFiles.length} 个文件（基线 ${scope.baseRef}）`
  })
  let output: AgentResult = null
  try {
    output = await host.agent(buildPrompt(request, scope), {
      taskId: 'code-review',
      phase: 'review',
      isolation: 'readonly',
      interactive: false,
      schema: CODE_REVIEW_SCHEMA,
      label: 'code-review'
    })
  } catch {
    output = null
  }

  const review = normalizeCodeReview(output)
  if (!review) {
    host.progress('review', 'failed', { message: 'review 未产出结构化审查结论' })
    return null
  }
  host.progress('review', review.verdict === 'block' ? 'failed' : 'completed', {
    message: `${review.verdict}：critical=${review.criticalCount} high=${review.highCount}`
  })
  return review
}

/** 交付摘要：结论与问题清单优先，正面反馈和待确认项在后 */
function buildSummary(scope: CodeReviewScope, review: CodeReviewResult): string {
  const lines = [
    `审查结论：${review.verdict}`,
    review.summary,
    '',
    `范围：${scope.origin === 'working-tree' ? '工作区未提交改动' : `最近一次提交（${scope.baseRef}）`}，${scope.changedFiles.length + scope.untrackedFiles.length} 个文件`
  ]
  if (review.findings.length > 0) {
    lines.push('', '问题：')
    for (const finding of review.findings) {
      const location = finding.file
        ? `${finding.file}${finding.line !== undefined ? `:${finding.line}` : ''} `
        : ''
      lines.push(`- [${finding.severity}] ${location}${finding.summary}`)
      if (finding.suggestion) lines.push(`  建议：${finding.suggestion}`)
    }
  } else {
    lines.push('', '未发现问题。')
  }
  if (review.strengths.length > 0) {
    lines.push('', '做得好的地方：', ...review.strengths.map((item) => `- ${item}`))
  }
  if (review.unverified.length > 0) {
    lines.push('', '未能验证，需人工确认：', ...review.unverified.map((item) => `- ${item}`))
  }
  return lines.join('\n')
}

export const codeReviewWorkflow: WorkflowDefinition = {
  name: 'code-review',
  description:
    '收集工作区未提交改动或最近一次提交的 git 变更面，做只读代码审查并给出带文件行号的问题清单。不修改代码。',
  matchHints: ['审查代码', 'review 我的改动', '看看这次改动有没有问题', '检查刚写的代码质量'],
  stages: [...CODE_REVIEW_ENTRY_STAGES],
  async run(ctx): Promise<WorkflowResult> {
    if (ctx.abortSignal.aborted) return { status: 'failed', reason: 'workflow cancelled' }

    const scope = await collectCodeReviewScope(ctx.host)
    if (!scope) {
      return {
        status: 'failed',
        reason: '无法确定审查范围：当前目录不是 git 仓库，或没有未提交改动与可比较的上一次提交'
      }
    }

    if (ctx.abortSignal.aborted) return { status: 'failed', reason: 'workflow cancelled' }
    const review = await runCodeReview(ctx.host, ctx.request, scope)
    if (!review) return { status: 'failed', reason: 'review failed' }

    const outcome: CodeReviewOutcome = { scope, review }
    return {
      status: 'completed',
      summary: buildSummary(scope, review),
      result: outcome
    }
  }
}

export { collectCodeReviewScope } from './scope'
export type {
  CodeReviewFinding,
  CodeReviewOrigin,
  CodeReviewOutcome,
  CodeReviewResult,
  CodeReviewScope,
  CodeReviewSeverity,
  CodeReviewVerdict
} from './types'

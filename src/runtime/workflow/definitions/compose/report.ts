import type { HostFns } from '../../host'
import type {
  ComposeReportInput,
  ReportOutcome,
  ReportResult,
  ReviewIssue,
  ReviewVerdict,
  VerifyResult
} from './types'

const OUTCOME_TEXT: Record<ReportOutcome, string> = {
  completed: '编排完成',
  completed_with_concerns: '编排完成但存在遗留问题',
  blocked: '编排受阻'
}

const VERDICT_TEXT: Record<ReviewVerdict, string> = {
  pass: '审查通过',
  conditional: '审查有条件通过',
  block: '审查判定阻塞'
}

/** 实现整体失败或审查判定阻塞：成果不可交付。 */
function isBlocked(input: ComposeReportInput): boolean {
  return input.implement.status === 'failed' || input.review.verdict === 'block'
}

/** 有任务失败、验证未全绿、有条件通过或存在高危问题：可交付但有遗留。 */
function hasConcerns(input: ComposeReportInput): boolean {
  return (
    input.implement.status === 'partial' ||
    !input.verify.passed ||
    input.review.verdict === 'conditional' ||
    input.review.criticalCount > 0 ||
    input.review.highCount > 0
  )
}

function resolveOutcome(input: ComposeReportInput): ReportOutcome {
  if (isBlocked(input)) return 'blocked'
  return hasConcerns(input) ? 'completed_with_concerns' : 'completed'
}

function verifyText(verify: VerifyResult): string {
  if (verify.passed) return '验证检查全部通过'
  const failed = verify.failedChecks.join('、')
  return failed ? `验证未通过（${failed}）` : '验证未通过'
}

function buildSummary(input: ComposeReportInput, outcome: ReportOutcome): string {
  const succeeded = input.implement.succeededTaskIds.length
  const failed = input.implement.failedTaskIds.length
  return (
    `${OUTCOME_TEXT[outcome]}：${succeeded} 个任务成功、${failed} 个任务失败，` +
    `${verifyText(input.verify)}，${VERDICT_TEXT[input.review.verdict]}。`
  )
}

function issueText(issue: ReviewIssue): string {
  const location = issue.file
    ? `${issue.file}${issue.line === undefined ? '' : `:${issue.line}`} `
    : ''
  return `审查 ${issue.severity} 问题：${location}${issue.summary}`
}

function buildHighlights(input: ComposeReportInput): string[] {
  return input.implement.tasks
    .filter((task) => task.status === 'succeeded')
    .map((task) => `${task.taskId} ${task.title}${task.summary ? `：${task.summary}` : ''}`)
}

function buildFailures(input: ComposeReportInput): string[] {
  const failures = input.implement.tasks
    .filter((task) => task.status === 'failed')
    .map((task) => `${task.taskId} ${task.title} 失败：${task.failure ?? '原因未记录'}`)
  if (input.implement.fatalReason) {
    failures.push(`实现阶段中止：${input.implement.fatalReason}`)
  }
  for (const check of input.verify.checks) {
    if (!check.passed) {
      failures.push(`${check.name} 未通过（退出码 ${check.exitCode}）：${check.command}`)
    }
  }
  for (const issue of input.review.issues) {
    if (issue.severity === 'critical' || issue.severity === 'high') {
      failures.push(issueText(issue))
    }
  }
  return failures
}

/**
 * 由前序阶段的结构化事实确定性地归纳交付结论。
 *
 * 这里的输入全部已是结构化事实，再派子代理只会让「实现/验证/审查都成功、
 * 唯独汇报解析失败」变成整条工作流失败，所以本阶段不调用模型，也不会失败。
 */
export function runReport(host: HostFns, input: ComposeReportInput): ReportResult {
  host.progress('report', 'started')
  const outcome = resolveOutcome(input)
  const result: ReportResult = {
    outcome,
    summary: buildSummary(input, outcome),
    highlights: buildHighlights(input),
    failures: buildFailures(input),
    nextSteps: [...input.review.recommendations]
  }
  host.progress('report', 'completed', { message: result.summary })
  host.log(result.summary)
  return result
}

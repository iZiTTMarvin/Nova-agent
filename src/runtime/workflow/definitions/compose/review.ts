import type { HostFns, AgentResult } from '../../host'
import type { ImplementResult, ReviewIssue, ReviewResult, VerifyResult } from './types'
import type { WorkflowPlan } from '../../types'

export const REVIEW_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'conditional', 'block'] },
    summary: { type: 'string' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'nit'] },
          file: { type: 'string' },
          line: { type: 'number' },
          summary: { type: 'string' },
          suggestion: { type: 'string' }
        },
        required: ['severity', 'summary']
      }
    },
    strengths: { type: 'array', items: { type: 'string' } },
    recommendations: { type: 'array', items: { type: 'string' } }
  },
  required: ['verdict', 'summary', 'issues', 'strengths', 'recommendations']
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim())
}

function normalizeIssue(value: unknown): ReviewIssue | null {
  const record = asRecord(value)
  if (!record) return null
  const severity = record.severity
  if (
    severity !== 'critical' &&
    severity !== 'high' &&
    severity !== 'medium' &&
    severity !== 'low' &&
    severity !== 'nit'
  ) {
    return null
  }
  const summary = asString(record.summary) ?? asString(record.description)
  if (!summary) return null
  const line = typeof record.line === 'number' && Number.isInteger(record.line) ? record.line : undefined
  return {
    severity,
    ...(asString(record.file) ? { file: asString(record.file) } : {}),
    ...(line !== undefined ? { line } : {}),
    summary,
    ...(asString(record.suggestion) ? { suggestion: asString(record.suggestion) } : {})
  }
}

export function normalizeReview(value: AgentResult): ReviewResult | null {
  const record = asRecord(value)
  if (!record) return null
  const verdict = record.verdict
  if (verdict !== 'pass' && verdict !== 'conditional' && verdict !== 'block') return null
  const rawIssues = Array.isArray(record.issues)
    ? record.issues
    : Array.isArray(record.findings)
      ? record.findings
      : []
  const issues = rawIssues
    .map(normalizeIssue)
    .filter((issue): issue is ReviewIssue => issue !== null)
  return {
    verdict,
    summary: asString(record.summary) ?? '审查完成。',
    issues,
    strengths: asStringList(record.strengths),
    recommendations: asStringList(record.recommendations ?? record.nextSteps),
    criticalCount: issues.filter((issue) => issue.severity === 'critical').length,
    highCount: issues.filter((issue) => issue.severity === 'high').length
  }
}

function buildPrompt(
  plan: WorkflowPlan,
  implement: ImplementResult,
  verify: VerifyResult
): string {
  return [
    '你负责 compose workflow 的 review 阶段。',
    '以真实工作区代码、测试结果和计划验收标准为证据，独立审查正确性、范围、架构边界、安全和可维护性。',
    '只读审查，不修改文件，不向用户提问。',
    '给出总体结论、逐条问题（标注严重级别与位置）、值得保留的优点和可执行的后续建议；每条问题都必须有真实证据支撑，不要凭猜测下判断。',
    '',
    `WorkflowPlan：\n${JSON.stringify(plan)}`,
    `Implement 结果：\n${JSON.stringify(implement)}`,
    `Verify 结果：\n${JSON.stringify(verify)}`
  ].join('\n')
}

export async function runReview(
  host: HostFns,
  plan: WorkflowPlan,
  implement: ImplementResult,
  verify: VerifyResult
): Promise<ReviewResult | null> {
  host.progress('review', 'started')
  let output: AgentResult = null
  try {
    output = await host.agent(buildPrompt(plan, implement, verify), {
      taskId: 'review',
      phase: 'review',
      isolation: 'readonly',
      interactive: false,
      schema: REVIEW_SCHEMA,
      label: 'compose-review'
    })
  } catch {
    output = null
  }

  const result = normalizeReview(output)
  if (!result) {
    host.progress('review', 'failed', { message: 'review 未产出结构化审查结论' })
    return null
  }
  host.progress('review', result.verdict === 'block' ? 'failed' : 'completed', {
    message: `${result.verdict}：critical=${result.criticalCount} high=${result.highCount}`
  })
  return result
}

import type { AgentResult, HostFns } from '../../host'
import type { ComposeReportInput, ReportResult } from './types'

export const REPORT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    outcome: { type: 'string', enum: ['completed', 'completed_with_concerns', 'blocked'] },
    summary: { type: 'string' },
    highlights: { type: 'array', items: { type: 'string' } },
    failures: { type: 'array', items: { type: 'string' } },
    nextSteps: { type: 'array', items: { type: 'string' } }
  },
  required: ['outcome', 'summary', 'highlights', 'failures', 'nextSteps']
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim())
}

export function normalizeReport(value: AgentResult): ReportResult | null {
  const record = asRecord(value)
  if (!record) return null
  const outcome = record.outcome
  if (
    outcome !== 'completed' &&
    outcome !== 'completed_with_concerns' &&
    outcome !== 'blocked'
  ) {
    return null
  }
  const summary = asString(record.summary)
  if (!summary) return null
  return {
    outcome,
    summary,
    highlights: asStringList(record.highlights),
    failures: asStringList(record.failures ?? record.concerns),
    nextSteps: asStringList(record.nextSteps ?? record.recommendations)
  }
}

function buildPrompt(input: ComposeReportInput): string {
  return [
    '你负责 compose workflow 的 report 阶段。',
    '请根据以下结构化事实生成最终交付摘要，不要凭空声称未执行的验证通过。',
    '必须返回 outcome、summary、highlights、failures、nextSteps 的 JSON。',
    '若实现任务失败、验证失败或 review verdict 为 conditional/block，必须在 failures 中明确写出，并选择 completed_with_concerns 或 blocked。',
    '',
    `用户请求：\n${input.request}`,
    `WorkflowPlan：\n${JSON.stringify(input.plan)}`,
    `Brainstorm：\n${JSON.stringify(input.brainstorm)}`,
    `Implement：\n${JSON.stringify(input.implement)}`,
    `Verify：\n${JSON.stringify(input.verify)}`,
    `Review：\n${JSON.stringify(input.review)}`
  ].join('\n')
}

export async function runReport(
  host: HostFns,
  input: ComposeReportInput
): Promise<ReportResult | null> {
  host.progress('report', 'started')
  let output: AgentResult = null
  try {
    output = await host.agent(buildPrompt(input), {
      taskId: 'report',
      phase: 'report',
      isolation: 'readonly',
      interactive: false,
      schema: REPORT_SCHEMA,
      label: 'compose-report'
    })
  } catch {
    output = null
  }

  const result = normalizeReport(output)
  if (!result) {
    host.progress('report', 'failed', { message: 'report 未产出最终结构化摘要' })
    return null
  }
  host.progress('report', 'completed', { message: result.summary })
  host.log(result.summary)
  return result
}

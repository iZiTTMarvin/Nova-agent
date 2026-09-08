export interface InspectionVerdict {
  readonly verdict: 'pass' | 'fail'
  readonly summary: string
}

/** 身份与阶段由宿主填写，模型只能提交结论和依据。 */
export interface InspectionReport extends InspectionVerdict {
  readonly parentSessionId: string
  readonly stageEnteredAt: number
  readonly childRunId: string
  readonly messageId: string
}

export const INSPECTION_REPORT_INSTRUCTION =
  '在 XForge「验」阶段（提供 inspection_report 工具时），完成核验后必须调用 inspection_report，提交 verdict（pass 或 fail）和 summary（实际核验依据与未通过项），然后再给父代理简洁汇报。' +
  '报告正文的措辞、标点和格式不参与阶段放行。缺少正式结果时可基于本子会话已有的核验记录补交；证据不足或已过期时先重新核验。'

export function parseInspectionVerdict(value: unknown): InspectionVerdict | null {
  if (typeof value !== 'object' || value === null) return null
  if (!('verdict' in value) || (value.verdict !== 'pass' && value.verdict !== 'fail')) return null
  if (!('summary' in value) || typeof value.summary !== 'string') return null
  const summary = value.summary.trim()
  if (!summary || summary.length > 8000) return null
  return { verdict: value.verdict, summary }
}

export function parseInspectionReport(value: unknown): InspectionReport | null {
  const verdict = parseInspectionVerdict(value)
  if (!verdict || typeof value !== 'object' || value === null) return null
  if (!('parentSessionId' in value) || typeof value.parentSessionId !== 'string' || !value.parentSessionId) return null
  if (!('childRunId' in value) || typeof value.childRunId !== 'string' || !value.childRunId) return null
  if (!('messageId' in value) || typeof value.messageId !== 'string' || !value.messageId) return null
  if (!('stageEnteredAt' in value) || typeof value.stageEnteredAt !== 'number' || !Number.isFinite(value.stageEnteredAt) || value.stageEnteredAt < 0) return null
  return { ...verdict, parentSessionId: value.parentSessionId, childRunId: value.childRunId, messageId: value.messageId, stageEnteredAt: value.stageEnteredAt }
}

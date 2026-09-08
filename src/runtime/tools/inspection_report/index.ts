import { parseInspectionVerdict, type InspectionReport } from '../../../shared/composeLifecycle'
import { BUILTIN_SUBAGENT_IDS } from '../../../shared/subagents/presetIdentity'
import { assertSideEffectAllowed, type ToolExecutor } from '../types'

/** 结果随当前工具消息持久化；不写平行的验收状态或工作区报告文件。 */
export const inspectionReportTool: ToolExecutor = {
  name: 'inspection_report',
  description: 'inspector 提交当前 XForge 验收结论。先实际操作核验；提交 pass 或 fail 和核验依据，随后用自然语言汇报。主代理不能代交。',
  executionMode: 'sequential',
  parameters: {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['pass', 'fail'], description: '全部验收项通过选 pass；有未通过或未验证项选 fail。' },
      summary: { type: 'string', minLength: 1, maxLength: 8000, description: '实际核验了什么、观察到什么，以及未通过或未验证项。' }
    },
    required: ['verdict', 'summary'],
    additionalProperties: false
  },
  async execute(args, context) {
    const denied = (error: string) => ({ success: false, output: '', error })
    const verdict = parseInspectionVerdict(args)
    if (!verdict || Object.keys(args).some(key => key !== 'verdict' && key !== 'summary')) {
      return denied('请提供 verdict: pass 或 fail，以及 1–8000 字符的 summary；身份与阶段不能自行指定。')
    }
    assertSideEffectAllowed(context, '提交核验结果')
    const ref = context.invocationRef
    const store = context.sessionStore
    if (!ref || !store || ref.sessionId !== context.sessionId || ref.runId !== context.runId) {
      return denied('缺少当前核验调用身份，无法提交结果。')
    }
    const child = store.load(ref.sessionId)
    if (child?.kind !== 'subagent' || child.subagent.profile.profileId !== BUILTIN_SUBAGENT_IDS.inspector) {
      return denied('只有 inspector 子代理可以提交独立核验结果。')
    }
    const parentSessionId = child.subagent.lineage.parentSessionId
    const parent = store.load(parentSessionId)
    const stage = store.getComposeStages(parentSessionId)?.find(entry => entry.status === 'in_progress')
    if (parent?.mode !== 'compose' || stage?.id !== 'inspect' || stage.enteredAt === undefined) {
      return denied('父会话当前不在「验」阶段，不能提交核验结果。')
    }
    const report: InspectionReport = {
      ...verdict, parentSessionId, stageEnteredAt: stage.enteredAt,
      childRunId: ref.runId, messageId: ref.messageId
    }
    return { success: true, output: JSON.stringify(report) }
  }
}

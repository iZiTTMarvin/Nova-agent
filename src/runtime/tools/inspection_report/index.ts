import { parseInspectionVerdict, type InspectionReport } from '../../../shared/composeLifecycle'
import { BUILTIN_SUBAGENT_IDS } from '../../../shared/subagents/presetIdentity'
import { assertSideEffectAllowed, type ToolExecutor } from '../types'

/** 结果随当前工具消息持久化；不写平行的验收状态或工作区报告文件。 */
export const inspectionReportTool: ToolExecutor = {
  name: 'inspection_report',
  description: 'The inspector submits the current XForge acceptance verdict. Verify by actually operating first; submit pass or fail with the verification basis, then report in natural language. The main agent cannot submit on its behalf.',
  executionMode: 'sequential',
  parameters: {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['pass', 'fail'], description: 'Choose pass when all acceptance items pass; choose fail when something failed or remains unverified.' },
      summary: { type: 'string', minLength: 1, maxLength: 8000, description: 'What was actually verified, what was observed, and any failed or unverified items.' }
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

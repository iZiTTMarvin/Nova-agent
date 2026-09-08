import type { ComposeStageId } from './types'

export interface ComposeStageFacts {
  /** 当前阶段 enteredAt 之后，是否存在已完成的 critic 子代理 run */
  criticCompleted: boolean
  /** 本阶段最新核验运行已完成，且有正式 pass 与实际 shell 证据。 */
  inspectorPassed: boolean
  inspection?: {
    issue: 'missing_report' | 'missing_evidence' | 'failed' | 'not_completed'
    childSessionId: string
  }
}

const BLUEPRINT_CRITIC_DENIAL =
  '一页纸还没有经过批评者挑刺。先派 critic 子代理审一遍，把砍掉和补上的写进一页纸，再完成本阶段。'

const INSPECT_INSPECTOR_DENIAL =
  '还没有独立核验通过的记录。派 inspector 子代理按一页纸逐条操作；未通过就回到「锤」修，通过后再完成本阶段。'

/** 完成当前阶段前的事实门：只拒绝并返回人话，不改阶段表、不自动派遣。 */
export function getStageCompleteDenial(
  stageId: ComposeStageId,
  facts: ComposeStageFacts
): string | null {
  if (stageId === 'blueprint' && !facts.criticCompleted) {
    return BLUEPRINT_CRITIC_DENIAL
  }
  if (stageId === 'inspect' && !facts.inspectorPassed) {
    const inspection = facts.inspection
    if (inspection) {
      const followup = `使用 task_followup（child_session_id: ${inspection.childSessionId}）让原 inspector `
      if (inspection.issue === 'missing_report') {
        return `核验已执行，但缺少本阶段有效的 inspection_report 正式结果。${followup}基于已有核验记录补交 verdict 与 summary；不要重复跑已完成的检查或写文件代交。`
      }
      if (inspection.issue === 'missing_evidence') {
        return `核验结果缺少本阶段实际命令成功执行的记录。${followup}实际操作核验后重新提交 inspection_report。`
      }
      if (inspection.issue === 'failed') return '独立核验正式结果为未通过。请按核验报告回到「锤」修正，再重新核验；不要重复提交阶段完成。'
      return '最新 inspector 核验运行尚未成功完成。请检查子任务状态，等待运行结束或处理失败后续跑，不能用更早的通过结果放行。'
    }
    return INSPECT_INSPECTOR_DENIAL
  }
  return null
}

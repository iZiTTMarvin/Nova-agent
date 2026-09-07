import type { ComposeStageId } from './types'

export interface ComposeStageFacts {
  /** 当前阶段 enteredAt 之后，是否存在已完成的 critic 子代理 run */
  criticCompleted: boolean
  /** 当前阶段 enteredAt 之后，是否存在已完成的 inspector 子代理 run，其子会话含 exitCode===0 的 bash/shell_session，且最后一条 assistant 文本含「结论：通过」 */
  inspectorPassed: boolean
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
    return INSPECT_INSPECTOR_DENIAL
  }
  return null
}

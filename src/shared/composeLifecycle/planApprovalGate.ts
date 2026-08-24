import { getComposeStageCursor } from './transitions'
import type { ComposePlanApproval, ComposeStageEntry } from './types'

/**
 * 计划确认门判定（仅 apply complete 使用）：从「计划」阶段 complete 出去前必须有批准。
 *
 * 工具路径（stage_transition）与手动 IPC 路径（compose:apply-stage-transition）
 * 共用这一份判定，避免两处口径漂移。放行方式由调用方编排：
 * 工具在 auto 模式下自动批准放行、否则拒绝；手动 IPC 把「用户点击完成」本身视为
 * 用户决策，写批准留痕后放行。skip/return 不受此门约束（与工具既有语义一致）。
 */
export function getPlanCompleteDenial(
  stages: ReadonlyArray<Pick<ComposeStageEntry, 'id' | 'status'>> | null | undefined,
  approval: ComposePlanApproval | null
): string | null {
  if (!stages) return null // 无阶段表时由 apply 统一建表/报错
  const cursor = getComposeStageCursor(stages)
  if (cursor.currentStageId !== 'plan') return null
  if (approval?.status === 'approved') return null
  return '计划尚未获得用户批准，无法完成「计划」阶段。请通过当前任务的计划审阅交互等待用户决定。'
}

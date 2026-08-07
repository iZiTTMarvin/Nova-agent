/**
 * compose 会话的阶段指南注入与阶段工具门禁装配。
 * 两个闭包每轮实时读取阶段表：切阶段只改 user 消息尾部与门禁判定，
 * 历史消息不动，缓存前缀全保留。
 */
import type { SessionStore } from '../../../runtime/sessions/SessionStore'
import type { ToolAuthorizationPolicy } from '../../../runtime/permissions/PermissionCoordinator'
import { getModeInstruction } from '../../../runtime/agent/promptBuilder/modeInstruction'
import { getComposeStageGuide } from '../../../runtime/agent/promptBuilder/stageGuides'
import {
  createInitialStageTable,
  getComposeStageCursor,
  getComposeStageToolDenial,
  type ComposeStageId
} from '../../../shared/composeLifecycle'

/** 当前进行中阶段；旧会话无阶段表时按初始表处理，生命周期终态返回 null */
function currentStageId(sessionStore: SessionStore, sessionId: string): ComposeStageId | null {
  const stages = sessionStore.getComposeStages(sessionId) ?? createInitialStageTable()
  return getComposeStageCursor(stages).currentStageId
}

/**
 * auto 轮次的确认门说明：构思软门与计划硬门自动通过。
 * 共识与计划照常发到消息流保持透明，但模型不得停下等待用户确认。
 */
const COMPOSE_AUTO_GATE_NOTE =
  '[自动推进已开启] 构思与计划的确认门自动通过：照常把需求共识与计划发出来保持透明，' +
  '但不要停下等待用户确认，依据已有信息自行作出安全决定并继续推进阶段。'

/** 模式指令 + 当前阶段指南，每轮由 AgentLoop 调用后追加到 user 消息尾部 */
export function createComposeModeInstructionProvider(
  sessionStore: SessionStore,
  sessionId: string,
  autoMode: boolean
): () => string {
  return () => {
    const base = getModeInstruction('compose')
    const stageId = currentStageId(sessionStore, sessionId)
    const guide = stageId ? `\n\n${getComposeStageGuide(stageId)}` : ''
    const autoNote = autoMode ? `\n\n${COMPOSE_AUTO_GATE_NOTE}` : ''
    return `${base}${guide}${autoNote}`
  }
}

/** 阶段工具门禁 overlay：在基础权限判定之前生效，终态后不再收放 */
export function createComposeStageToolPolicy(
  sessionStore: SessionStore,
  sessionId: string
): ToolAuthorizationPolicy {
  return (toolName) => {
    // 编排引擎已废弃：物理拦截旧入口，否则开发起的阶段里模型仍可能调通
    // 旧流水线，与亲自推进的生命周期相互冲突。
    // 删除条件：编排引擎与 start_workflow 工具从代码库移除时，本拦截一并删除；
    // 保护测试：composeStageWiring 的 start_workflow 拦截用例。
    if (toolName === 'start_workflow') {
      return {
        allowed: false,
        reason:
          'start_workflow 已废弃：compose 模式由你亲自按阶段推进，阶段转换请调用 stage_transition。'
      }
    }
    const stageId = currentStageId(sessionStore, sessionId)
    if (!stageId) {
      return { allowed: true, reason: '' }
    }
    const denial = getComposeStageToolDenial(stageId, toolName)
    return denial ? { allowed: false, reason: denial } : { allowed: true, reason: '' }
  }
}

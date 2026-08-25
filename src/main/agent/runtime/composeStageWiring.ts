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

/** 模式指令 + 当前阶段指南，每轮由 AgentLoop 调用后追加到 user 消息尾部 */
export function createComposeModeInstructionProvider(
  sessionStore: SessionStore,
  sessionId: string
): () => string {
  return () => {
    const base = getModeInstruction('compose')
    const stageId = currentStageId(sessionStore, sessionId)
    const guide = stageId ? `\n\n${getComposeStageGuide(stageId)}` : ''
    return `${base}${guide}`
  }
}

/** 阶段工具门禁 overlay：在基础权限判定之前生效，终态后不再收放 */
export function createComposeStageToolPolicy(
  sessionStore: SessionStore,
  sessionId: string
): ToolAuthorizationPolicy {
  return (toolName, args) => {
    const stageId = currentStageId(sessionStore, sessionId)
    if (!stageId) {
      return { allowed: true, reason: '' }
    }
    const denial = getComposeStageToolDenial(stageId, toolName, args)
    return denial ? { allowed: false, reason: denial } : { allowed: true, reason: '' }
  }
}

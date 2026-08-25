/**
 * compose 阶段工具门禁：按当前进行中阶段收窄可用工具。
 * 阶段指南是面向模型的软约束，本函数是权限 overlay 的硬约束，
 * 在基础权限判定之前生效。
 */
import { getToolPermissionDescriptor } from '../permissions/toolEffects'
import { COMPOSE_STAGE_LABELS, type ComposeStageId } from './types'

function isComposeReadonlyTool(toolName: string): boolean {
  const descriptor = getToolPermissionDescriptor(toolName)
  if (!descriptor) return false
  return descriptor.effects.every(
    effect =>
      effect === 'filesystem.read' ||
      effect === 'network.read' ||
      effect === 'session.write'
  )
}

/**
 * 返回当前阶段下该工具的拒绝原因；null 表示放行（不干预）。
 *
 * stage_transition / todo_write / askQuestion 等只写会话元数据的工具，
 * 在所有阶段放行——否则无法推进阶段、维护任务清单或向用户提问。
 * 「开发」起不再按阶段收放，回到基础权限（危险命令仍由既有策略拦截）。
 */
export function getComposeStageToolDenial(
  stage: ComposeStageId,
  toolName: string,
  args?: Record<string, unknown>
): string | null {
  if (stage !== 'brainstorm' && stage !== 'plan') {
    return null
  }

  const label = COMPOSE_STAGE_LABELS[stage]

  if (toolName === 'shell_session') {
    if (args?.action === 'write') {
      return (
        `当前处于「${label}」阶段，禁止向终端会话写入输入，"${toolName}" 已被拦截。` +
        'read/interrupt/stop 可继续使用；进入「开发」阶段后即可写入。'
      )
    }
    return null
  }

  if (stage === 'brainstorm') {
    if (isComposeReadonlyTool(toolName)) {
      return null
    }
    return (
      `当前处于「${label}」阶段，仅可使用只读工具，"${toolName}" 已被拦截。` +
      '与用户澄清需求并获得明确确认后，调用 stage_transition 完成本阶段即可解锁。'
    )
  }

  if (isComposeReadonlyTool(toolName) || toolName === 'save_plan') {
    return null
  }
  return (
    `当前处于「${label}」阶段，仅可使用只读工具与 save_plan，"${toolName}" 已被拦截。` +
    '计划经用户明确批准后，调用 stage_transition 进入「开发」阶段即可解锁。'
  )
}

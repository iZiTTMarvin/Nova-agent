/**
 * compose 阶段工具门禁：按当前进行中阶段收窄可用工具。
 * 阶段指南是面向模型的软约束，本函数是权限 overlay 的硬约束，
 * 在基础权限判定之前生效（auto 语义下同样生效）。
 */
import { getToolCapability } from '../session/toolVisibility'
import { COMPOSE_STAGE_LABELS, type ComposeStageId } from './types'

/**
 * 返回当前阶段下该工具的拒绝原因；null 表示放行（不干预）。
 *
 * stage_transition / todo_write / askQuestion 等只写会话元数据的工具归为 readonly，
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
  const capability = getToolCapability(toolName)

  // shell-session 按 action 收放：read/interrupt/stop 是只读观察，各阶段可用；
  // write 可执行任意内容，brainstorm 与 plan 阶段一律拒绝。
  if (capability === 'shell-session') {
    if (args?.action === 'write') {
      return (
        `当前处于「${label}」阶段，禁止向终端会话写入输入，"${toolName}" 已被拦截。` +
        'read/interrupt/stop 可继续使用；进入「开发」阶段后即可写入。'
      )
    }
    return null
  }

  if (stage === 'brainstorm') {
    if (capability === 'readonly') {
      return null
    }
    return (
      `当前处于「${label}」阶段，仅可使用只读工具，"${toolName}" 已被拦截。` +
      '与用户澄清需求并获得明确确认后，调用 stage_transition 完成本阶段即可解锁。'
    )
  }

  // plan：只读 + 写计划文档（save_plan）
  if (capability === 'readonly' || capability === 'plan-artifact') {
    return null
  }
  return (
    `当前处于「${label}」阶段，仅可使用只读工具与 save_plan，"${toolName}" 已被拦截。` +
    '计划经用户明确批准后，调用 stage_transition 进入「开发」阶段即可解锁。'
  )
}

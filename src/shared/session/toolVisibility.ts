import type { Mode } from './types'

/** 工具能力分类：驱动可见性和权限规则共用同一套基础语义 */
export type ToolCapability = 'readonly' | 'write' | 'bash' | 'orchestration' | 'unknown'

/** 根据工具名归类，避免 UI、模型可见性和权限规则各写一套判断 */
export function getToolCapability(toolName: string): ToolCapability {
  switch (toolName) {
    case 'ls':
    case 'read':
    case 'grep':
    case 'find':
    case 'web_search':
      return 'readonly'
    case 'edit':
    case 'write':
      return 'write'
    case 'bash':
      return 'bash'
    case 'todo_write':
      // todo_write 写的是会话级元数据，不动文件系统。
      // 归为 readonly：plan 模式下可见且可用，UI 不会被染成危险操作色，
      // PermissionManager 走读类工具的宽松默认规则。
      return 'readonly'
    case 'askQuestion':
      // askQuestion 是用户交互工具：阻塞等待用户回答，不触碰文件系统 / shell，无副作用。
      // 归为 readonly，使其在所有模式下直接放行、无需"执行前确认"，且 plan 模式下可见可用
      // （在 plan 阶段向用户澄清偏好/方案选择正是其典型用途）。
      // 若不分类，会落到 default 分支 'unknown'，被权限层当作 bash 处理而要求确认（已知 bug）。
      return 'readonly'
    case 'task':
    case 'invoke_skill':
      // 编排类工具：本身没有文件系统/shell 副作用，只负责派遣子代理 / 调用技能。
      // 真正的副作用由子代理内部的 bash/write 等工具各自走权限检查（见 subAgentBridge），
      // 因此派遣动作本身不应再拦截一次（否则双重弹窗，且与主流 agent 行为不一致）。
      // 归为独立 orchestration 分类：default/auto 直接放行，plan 模式仍按非只读处理（deny + 隐藏）。
      return 'orchestration'
    default:
      return 'unknown'
  }
}

/** 当前模式下模型/UI 是否应该看见该工具 */
export function isToolVisibleInMode(mode: Mode, toolName: string): boolean {
  if (mode !== 'plan') {
    return true
  }

  return getToolCapability(toolName) === 'readonly'
}

/** 是否属于 plan 模式下应完全隐藏的写入类工具 */
export function isModeHiddenWriteTool(mode: Mode, toolName: string): boolean {
  if (mode !== 'plan') {
    return false
  }

  const capability = getToolCapability(toolName)
  return capability === 'write' || capability === 'bash'
}

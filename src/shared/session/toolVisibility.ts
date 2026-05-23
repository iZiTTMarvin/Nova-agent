import type { Mode } from './types'

/** 工具能力分类：驱动可见性和权限规则共用同一套基础语义 */
export type ToolCapability = 'readonly' | 'write' | 'bash' | 'unknown'

/** 根据工具名归类，避免 UI、模型可见性和权限规则各写一套判断 */
export function getToolCapability(toolName: string): ToolCapability {
  switch (toolName) {
    case 'ls':
    case 'read':
    case 'grep':
    case 'find':
      return 'readonly'
    case 'edit':
    case 'write':
      return 'write'
    case 'bash':
      return 'bash'
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

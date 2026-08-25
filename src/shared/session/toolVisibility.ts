import type { Mode } from './types'
import { getToolPermissionDescriptor } from '../permissions/toolEffects'

/** 当前模式下模型/UI 是否应该看见该工具 */
export function isToolVisibleInMode(mode: Mode, toolName: string): boolean {
  if (toolName === 'stage_transition') {
    return mode === 'compose'
  }
  if (mode === 'compose' && toolName === 'switch_mode') {
    return false
  }
  if (mode !== 'plan') {
    return true
  }

  if (
    toolName === 'save_plan' ||
    toolName === 'switch_mode' ||
    toolName === 'shell_session'
  ) {
    return true
  }

  const descriptor = getToolPermissionDescriptor(toolName)
  if (!descriptor) return false
  if (descriptor.effects.includes('orchestration')) return false
  if (descriptor.effects.includes('filesystem.write')) return false
  if (descriptor.effects.includes('shell.execute')) return false
  return true
}

/** 使用与权限层相同的 effects 描述收窄模型可见工具，供 native schema 与 XML 工具目录共用。 */
export function getModeVisibleTools<T extends { name: string }>(
  mode: Mode,
  tools: readonly T[]
): T[] {
  return tools.filter(tool => isToolVisibleInMode(mode, tool.name))
}

/** 是否属于 plan 模式下应完全隐藏的写入类工具 */
export function isModeHiddenWriteTool(mode: Mode, toolName: string): boolean {
  if (mode !== 'plan') {
    return false
  }
  if (toolName === 'save_plan' || toolName === 'shell_session') {
    return false
  }
  const descriptor = getToolPermissionDescriptor(toolName)
  if (!descriptor) return false
  return (
    descriptor.effects.includes('filesystem.write') ||
    descriptor.effects.includes('shell.execute')
  )
}

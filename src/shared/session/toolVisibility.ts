import type { Mode } from './types'
import type { PermissionCapabilityCeiling } from '../permissions/types'
import {
  getToolPermissionDescriptor,
  isToolAvailableWithinCapabilityCeiling
} from '../permissions/toolEffects'
import type { ToolPermissionDescriptor } from '../permissions/types'

function hasPlanHiddenEffects(
  descriptor: ToolPermissionDescriptor,
  options: { includeOrchestration: boolean }
): boolean {
  return (
    (options.includeOrchestration && descriptor.effects.includes('orchestration')) ||
    descriptor.effects.includes('filesystem.write') ||
    descriptor.effects.includes('shell.execute')
  )
}

/** 当前产品模式下模型/UI 是否应该看见该工具 */
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
  return !hasPlanHiddenEffects(descriptor, { includeOrchestration: true })
}

/** 使用产品模式收窄模型可见工具，供 native schema 与 XML 工具目录共用。 */
export function getModeVisibleTools<T extends { name: string }>(
  mode: Mode,
  tools: readonly T[]
): T[] {
  return tools.filter(tool => isToolVisibleInMode(mode, tool.name))
}

/** 产品模式与 hard capability 共同决定当前 Runtime 可暴露的工具。 */
export function getRuntimeVisibleTools<T extends { name: string }>(
  mode: Mode,
  tools: readonly T[],
  capabilityCeiling: PermissionCapabilityCeiling | null
): T[] {
  return getModeVisibleTools(mode, tools).filter(tool =>
    isToolAvailableWithinCapabilityCeiling(tool.name, capabilityCeiling)
  )
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
  return hasPlanHiddenEffects(descriptor, { includeOrchestration: false })
}

/**
 * Tool Economy 内部策略开关：工程评估用途，不提供用户设置 UI。
 * 通过 NOVA_TOOL_ECONOMY=off|shadow|on 控制；默认 off（全量工具面，行为不变）。
 */
import type { ToolEconomyMode } from './ToolAvailability'

export function resolveToolEconomyMode(
  env: { readonly NOVA_TOOL_ECONOMY?: string | undefined } = process.env
): ToolEconomyMode {
  const raw = env.NOVA_TOOL_ECONOMY?.trim().toLowerCase()
  if (raw === 'shadow' || raw === 'on') return raw
  if (raw !== undefined && raw !== '' && raw !== 'off') {
    console.warn(`[tool-economy] 未知的 NOVA_TOOL_ECONOMY 值 "${raw}"，回退 off`)
  }
  return 'off'
}

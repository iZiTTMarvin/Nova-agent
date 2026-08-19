/**
 * Tool Presentation（§22/§36）：能力如何交给模型——原生直调 or run_code 沙箱。
 * 会话/进程内保持稳定，避免 direct↔code 反复切换造成请求形态抖动。
 * 内部实验开关（默认 direct，行为与历史一致），不提供用户设置 UI。
 */
import { getCatalogEntry } from '../tools/catalog'

export type ToolPresentationMode = 'direct' | 'code-readonly'

export function resolveToolPresentationMode(
  env: { readonly NOVA_TOOL_PRESENTATION?: string | undefined } = process.env
): ToolPresentationMode {
  const raw = env.NOVA_TOOL_PRESENTATION?.trim().toLowerCase()
  if (raw === 'code-readonly') return 'code-readonly'
  if (raw !== undefined && raw !== '' && raw !== 'direct') {
    console.warn(`[code-mode] 未知的 NOVA_TOOL_PRESENTATION 值 "${raw}"，回退 direct`)
  }
  return 'direct'
}

/**
 * 呈现层投影（§23/§24，位于 Mode → Availability 之后）：
 * - direct：run_code 不进模型可见面（无 SDK 时该工具无意义）
 * - code-readonly：nestable-readonly 工具不再作为直调 schema 出现，改由 SDK 暴露
 */
export function applyToolPresentation<T extends { name: string }>(
  presentation: ToolPresentationMode,
  tools: readonly T[]
): T[] {
  if (presentation === 'code-readonly') {
    return tools.filter(tool => getCatalogEntry(tool.name)?.codeMode !== 'nestable-readonly')
  }
  return tools.filter(tool => tool.name !== 'run_code')
}


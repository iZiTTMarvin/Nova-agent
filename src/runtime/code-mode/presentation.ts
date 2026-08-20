/**
 * Tool Presentation：能力如何交给模型——原生直调 or run_code 沙箱。
 * 进程内只在首次装配时解析一次，避免运行中途翻转造成「schema 宣传与执行闸门」分裂；
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

let processPresentation: ToolPresentationMode | null = null

/**
 * 进程级呈现模式：首次调用解析并缓存，此后整个进程生命周期不变。
 * 装配层（prompt/SDK/工具注册/执行闸门）统一从这里取值，保证会话内形态稳定。
 */
export function getProcessToolPresentationMode(): ToolPresentationMode {
  processPresentation ??= resolveToolPresentationMode()
  return processPresentation
}

/**
 * 呈现层投影（位于 Mode → Availability 之后，只改变调用形式不改变能力边界）：
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

/** 只判断 direct/native 调用形式，不吸收 Mode 或 Availability 的授权语义。 */
export function isToolDirectlyPresented(
  presentation: ToolPresentationMode,
  toolName: string
): boolean {
  return applyToolPresentation(presentation, [{ name: toolName }]).length === 1
}

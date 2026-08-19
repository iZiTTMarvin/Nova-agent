/**
 * Tool Presentation（§22/§36）：能力如何交给模型——原生直调 or run_code 沙箱。
 * 会话/进程内保持稳定，避免 direct↔code 反复切换造成请求形态抖动。
 * 内部实验开关（默认 direct，行为与历史一致），不提供用户设置 UI。
 */

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

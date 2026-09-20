/**
 * 会话有效模型解析 — 会话覆盖优先，否则跟随注册表全局最近选择。
 *
 * turn 执行、上下文窗口与 vision 判定必须共用这一份解析；
 * 各处不得再单独读全局配置，否则会话隔离与 fallback 链会分叉。
 */
import { app } from 'electron'
import type { ModelConfig } from '../../shared/config'
import {
  resolveFallbackModelConfigs,
  resolveModelConfig,
  resolveSessionModelRef
} from '../../shared/config/llmRegistry'
import { loadLlmRegistry } from '../../runtime/model/config'

/** 解析会话当前应使用的模型配置（含 fallback 链）；注册表缺失或不可解析时为 null。 */
export function resolveSessionModelConfig(
  session: { readonly modelOverride?: { providerId: string; modelEntryId: string } }
): ModelConfig | null {
  let registry
  try {
    registry = loadLlmRegistry(app.getPath('userData'))
  } catch {
    return null
  }
  if (!registry) return null

  const active = resolveModelConfig(registry, resolveSessionModelRef(registry, session.modelOverride))
  if (!active) return null
  const fallbacks = resolveFallbackModelConfigs(registry)
  return fallbacks.length > 0 ? { ...active, fallbacks } : active
}

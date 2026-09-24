/**
 * ModelClientHost — 主进程全局 ModelClient 与「全局最近模型选择」的单一收口。
 *
 * 会话级 turn 不按此单例取模型（见 AgentTurnService 的会话模型解析）；
 * 本模块只负责：无会话兜底 client、注册表 activeModel 回写后的内存同步。
 */
import type { ModelClient } from '../../runtime/model/ModelClient'
import type { ModelConfig } from '../../shared/config'
import type { ActiveModelRef, LlmRegistry } from '../../shared/config/llmRegistry'
import {
  resolveActiveModelConfig,
  resolveFallbackModelConfigs
} from '../../shared/config/llmRegistry'
import { resolveCacheProfile } from '../../runtime/model/cacheProfile'
import { setActiveModelInRegistry } from '../../runtime/model/config'
import { OpenAICompatibleModelClient } from '../../runtime/model/OpenAICompatibleModelClient'
import { createModelClient } from './createModelClient'

let modelClient: ModelClient | null = null

export function getModelClient(): ModelClient | null {
  return modelClient
}

export function setModelClient(client: ModelClient | null): void {
  modelClient = client
}

/** 用 ModelConfig 更新主进程全局 ModelClient */
export function applyModelConfigToClient(config: ModelConfig): void {
  const profile = resolveCacheProfile(config.baseUrl, config.modelId, {
    cacheProfile: config.cacheProfile,
    cacheStrategy: config.cacheStrategy
  })
  const strategy = profile.marker === 'cache_control' ? 'anthropic' : 'auto'

  const activeClient = getModelClient()
  if (activeClient) {
    activeClient.updateConfig(config)
    if (activeClient instanceof OpenAICompatibleModelClient) {
      activeClient.setCacheStrategy(strategy)
    }
  } else {
    const client = createModelClient(config)
    client.setCacheStrategy(strategy)
    setModelClient(client)
  }
}

/** 从注册表同步活跃模型到 ModelClient */
export function syncActiveModelFromRegistry(registry: LlmRegistry): void {
  const active = resolveActiveModelConfig(registry)
  if (!active) return
  const fallbacks = resolveFallbackModelConfigs(registry)
  const config = fallbacks.length > 0 ? { ...active, fallbacks } : active
  applyModelConfigToClient(config)
}

/** 回写全局最近模型选择，并同步无会话时使用的内存 client。 */
export function applyActiveModelRef(appDataPath: string, ref: ActiveModelRef): void {
  const registry = setActiveModelInRegistry(appDataPath, ref)
  syncActiveModelFromRegistry(registry)
}

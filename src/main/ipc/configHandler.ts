import { app } from 'electron'
import { handle } from './secureIpc'
import {
  SAVE_MODEL_CONFIG,
  LOAD_MODEL_CONFIG,
  LOAD_LLM_REGISTRY,
  SAVE_LLM_REGISTRY,
  SET_ACTIVE_MODEL,
  FETCH_PROVIDER_MODELS
} from '../../shared/ipc/channels'
import type { ModelConfig } from '../../shared/config'
import type { LlmRegistry } from '../../shared/config/llmRegistry'
import { maskApiKey, isMaskedApiKey } from '../../shared/config/apiKeyMask'
import {
  saveModelConfig,
  loadModelConfig,
  loadLlmRegistry,
  saveLlmRegistry
} from '../../runtime/model/config'
import { fetchProviderModels } from '../../runtime/model/fetchProviderModels'
import {
  applyActiveModelRef,
  applyModelConfigToClient,
  syncActiveModelFromRegistry
} from '../services/ModelClientHost'
import { electronTransportFetch } from '../network/electronTransportFetch'
import { getWorkspaceService } from '../services/WorkspaceService'

/** 返回渲染层前掩码所有 provider 的 apiKey */
function maskRegistryForRenderer(registry: LlmRegistry): LlmRegistry {
  return {
    ...registry,
    providers: registry.providers.map(p => ({
      ...p,
      apiKey: p.apiKey ? maskApiKey(p.apiKey) : ''
    }))
  }
}

/**
 * 保存前合并：渲染层回传的掩码 key 用磁盘明文替换（用户未修改 key 时）
 */
function mergeRegistryApiKeys(incoming: LlmRegistry, onDisk: LlmRegistry | null): LlmRegistry {
  if (!onDisk) return incoming

  const diskById = new Map(onDisk.providers.map(p => [p.id, p]))
  return {
    ...incoming,
    providers: incoming.providers.map(p => {
      if (!isMaskedApiKey(p.apiKey)) return p
      const prev = diskById.get(p.id)
      return prev ? { ...p, apiKey: prev.apiKey } : p
    })
  }
}

/**
 * 注册模型配置相关的 IPC 处理器
 */
export function registerConfigHandler(): void {
  // v1 兼容：保存单 ModelConfig
  handle(SAVE_MODEL_CONFIG, async (_event, rawConfig: ModelConfig): Promise<void> => {
    const config = saveModelConfig(rawConfig, app.getPath('userData'))
    applyModelConfigToClient(config)
    getWorkspaceService().refreshModelSelection()
  })

  // v1 兼容：加载活跃 ModelConfig（掩码后返回）
  handle(LOAD_MODEL_CONFIG, async (): Promise<ModelConfig | null> => {
    const config = loadModelConfig(app.getPath('userData'))
    if (!config) return null
    return { ...config, apiKey: maskApiKey(config.apiKey) }
  })

  // v2：加载完整注册表（掩码后返回）
  handle(LOAD_LLM_REGISTRY, async (): Promise<LlmRegistry | null> => {
    const registry = loadLlmRegistry(app.getPath('userData'))
    return registry ? maskRegistryForRenderer(registry) : null
  })

  // v2：保存注册表（合并掩码 key）
  handle(SAVE_LLM_REGISTRY, async (_event, registry: LlmRegistry): Promise<void> => {
    const userData = app.getPath('userData')
    const onDisk = loadLlmRegistry(userData)
    const merged = mergeRegistryApiKeys(registry, onDisk)
    const saved = saveLlmRegistry(userData, merged)
    syncActiveModelFromRegistry(saved)
    getWorkspaceService().refreshModelSelection()
  })

  // v2：快速切换全局最近模型（新会话与无覆盖会话的默认）
  handle(
    SET_ACTIVE_MODEL,
    async (_event, ref: { providerId: string; modelEntryId: string }): Promise<void> => {
      applyActiveModelRef(app.getPath('userData'), ref)
      getWorkspaceService().refreshModelSelection()
    }
  )

  // 从服务商 API 拉取模型列表
  handle(
    FETCH_PROVIDER_MODELS,
    async (_event, params: { baseUrl: string; apiKey: string }) => {
      return fetchProviderModels({ ...params, fetchImpl: electronTransportFetch })
    }
  )
}

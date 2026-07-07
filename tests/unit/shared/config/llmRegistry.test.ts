import { describe, it, expect } from 'vitest'
import {
  migrateV1ToV2,
  resolveModelConfig,
  resolveActiveModelConfig,
  validateLlmRegistry,
  createProviderFromPreset,
  mergeFetchedModelEntries,
  groupSelectableModels,
  resolveActiveModelAfterSave,
  PRESET_PROVIDERS
} from '../../../../src/shared/config/llmRegistry'
import type { ModelConfig, ProviderConfig } from '../../../../src/shared/config'

describe('llmRegistry', () => {
  const v1: ModelConfig = {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'sk-test',
    modelId: 'deepseek-chat',
    contextWindow: 64000
  }

  it('migrateV1ToV2 保留主模型字段', () => {
    const registry = migrateV1ToV2(v1)
    expect(registry.version).toBe(2)
    expect(registry.providers).toHaveLength(1)
    const cfg = resolveActiveModelConfig(registry)
    expect(cfg).toEqual({
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-test',
      modelId: 'deepseek-chat',
      contextWindow: 64000
    })
  })

  it('migrateV1ToV2 将 fallbacks 转为独立服务商', () => {
    const withFb: ModelConfig = {
      ...v1,
      fallbacks: [
        {
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-fb',
          modelId: 'gpt-4o-mini'
        }
      ]
    }
    const registry = migrateV1ToV2(withFb)
    expect(registry.providers.length).toBeGreaterThanOrEqual(2)
    expect(registry.fallbacks).toHaveLength(1)
  })

  it('createProviderFromPreset 填充预设模型', () => {
    const provider = createProviderFromPreset('glm', 'key-123')
    expect(provider.baseUrl).toBe(PRESET_PROVIDERS.glm.baseUrl)
    expect(provider.apiKey).toBe('key-123')
    expect(provider.models.length).toBeGreaterThan(0)
  })

  it('resolveModelConfig 在缺 key 时返回 null', () => {
    const provider = createProviderFromPreset('deepseek', '')
    const registry = validateLlmRegistry({
      version: 2,
      providers: [provider],
      activeModel: {
        providerId: provider.id,
        modelEntryId: provider.models[0].id
      }
    })
    expect(registry.valid).toBe(true)
    if (registry.valid) {
      expect(resolveActiveModelConfig(registry.registry)).toBeNull()
    }
  })

  it('mergeFetchedModelEntries 去重合并', () => {
    const provider = createProviderFromPreset('minimax', 'key')
    const existingId = provider.models[0].modelId
    const merged = mergeFetchedModelEntries(provider, [existingId, 'new-model-x'])
    expect(merged).toHaveLength(provider.models.length + 1)
    expect(merged.some(m => m.modelId === 'new-model-x')).toBe(true)
  })

  it('groupSelectableModels 按服务商分组', () => {
    const p1 = createProviderFromPreset('glm', 'key1')
    const p2 = createProviderFromPreset('deepseek', 'key2')
    const registry = {
      version: 2 as const,
      providers: [p1, p2],
      activeModel: { providerId: p1.id, modelEntryId: p1.models[0].id }
    }
    const groups = groupSelectableModels(registry)
    expect(groups).toHaveLength(2)
  })

  it('resolveModelConfig 合并 provider 级 toolDialect', () => {
    const provider = createProviderFromPreset('glm', 'key')
    provider.toolDialect = 'xml'
    const ref = { providerId: provider.id, modelEntryId: provider.models[0].id }
    const registry = {
      version: 2 as const,
      providers: [provider],
      activeModel: ref
    }
    const cfg = resolveModelConfig(registry, ref)
    expect(cfg?.toolDialect).toBe('xml')
  })

  it('resolveModelConfig 透传 entry 级 reasoningEffort（非 auto）', () => {
    const provider = createProviderFromPreset('deepseek', 'key')
    provider.models[0].reasoningEffort = 'high'
    const ref = { providerId: provider.id, modelEntryId: provider.models[0].id }
    const registry = {
      version: 2 as const,
      providers: [provider],
      activeModel: ref
    }
    const cfg = resolveModelConfig(registry, ref)
    expect(cfg?.reasoningEffort).toBe('high')
  })

  it('resolveModelConfig 在 reasoningEffort=auto 时不带该字段', () => {
    const provider = createProviderFromPreset('deepseek', 'key')
    provider.models[0].reasoningEffort = 'auto'
    const ref = { providerId: provider.id, modelEntryId: provider.models[0].id }
    const registry = {
      version: 2 as const,
      providers: [provider],
      activeModel: ref
    }
    const cfg = resolveModelConfig(registry, ref)
    expect(cfg?.reasoningEffort).toBeUndefined()
  })

  it('validateLlmRegistry 保留并规范化 reasoningEffort（非 auto）', () => {
    const provider = createProviderFromPreset('glm', 'key')
    provider.models[0].reasoningEffort = 'medium'
    const raw = {
      version: 2 as const,
      providers: [provider],
      activeModel: { providerId: provider.id, modelEntryId: provider.models[0].id }
    }
    const result = validateLlmRegistry(raw)
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.registry.providers[0].models[0].reasoningEffort).toBe('medium')
    }
  })

  it('validateLlmRegistry 在 reasoningEffort=auto 时剥离该字段', () => {
    const provider = createProviderFromPreset('glm', 'key')
    provider.models[0].reasoningEffort = 'auto'
    const raw = {
      version: 2 as const,
      providers: [provider],
      activeModel: { providerId: provider.id, modelEntryId: provider.models[0].id }
    }
    const result = validateLlmRegistry(raw)
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.registry.providers[0].models[0].reasoningEffort).toBeUndefined()
    }
  })
})

describe('resolveActiveModelAfterSave', () => {
  it('首次配置（activeModel 为空）应锚定到本次保存的服务商', () => {
    const saving = createProviderFromPreset('glm', 'key')
    const nextProviders = [saving]
    const result = resolveActiveModelAfterSave(
      { providerId: '', modelEntryId: '' },
      saving,
      nextProviders
    )
    expect(result).toEqual({ providerId: saving.id, modelEntryId: saving.models[0]!.id })
  })

  it('当前 activeModel 指向已被删除的 provider 时，应锚定到本次保存的服务商', () => {
    const saving = createProviderFromPreset('glm', 'key')
    const nextProviders = [saving]
    const result = resolveActiveModelAfterSave(
      { providerId: 'custom-deleted', modelEntryId: 'm-old' },
      saving,
      nextProviders
    )
    expect(result).toEqual({ providerId: saving.id, modelEntryId: saving.models[0]!.id })
  })

  it('当前 activeModel 指向其他仍有效的 provider 时，应保持不变', () => {
    const saving = createProviderFromPreset('glm', 'key')
    const other = createProviderFromPreset('deepseek', 'key2')
    const nextProviders = [other, saving]
    const currentActive = { providerId: other.id, modelEntryId: other.models[0]!.id }
    const result = resolveActiveModelAfterSave(currentActive, saving, nextProviders)
    expect(result).toBe(currentActive)
  })

  it('当前 activeModel 正指向本次保存的服务商（含 preset 占位 id）时，应更新到 toSave.id + 首个模型', () => {
    // 渲染层首次选中预设时落进 draft 的占位 id 为 `preset-<id>`，保存后 toSave.id 沿用占位 id
    const saving: ProviderConfig = {
      ...createProviderFromPreset('glm', 'key'),
      id: 'preset-glm',
      presetId: 'glm'
    }
    const nextProviders = [saving]
    const result = resolveActiveModelAfterSave(
      { providerId: 'preset-glm', modelEntryId: 'stale' },
      saving,
      nextProviders
    )
    expect(result).toEqual({ providerId: 'preset-glm', modelEntryId: saving.models[0]!.id })
  })
})

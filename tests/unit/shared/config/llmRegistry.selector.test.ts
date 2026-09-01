import { describe, expect, it } from 'vitest'
import {
  createCustomProvider,
  createProviderFromPreset,
  getModelDirectory,
  resolveModelSelector,
  validateReasoningEffort,
  type LlmRegistry,
  type ProviderConfig
} from '../../../../src/shared/config'

function providerWithModels(provider: ProviderConfig, models: ProviderConfig['models']): ProviderConfig {
  return { ...provider, models }
}

describe('resolveModelSelector (pure)', () => {
  function buildRegistry(): LlmRegistry {
    const glm = createProviderFromPreset('glm', 'key-glm')
    glm.id = 'glm'
    glm.name = 'GLM'
    glm.models = [
      { id: 'glm-52', modelId: 'glm-5.2', displayName: 'GLM-5.2', aliases: ['GLM 5.2 Flash'] },
      { id: 'glm-51', modelId: 'glm-5.1', displayName: 'GLM-5.1' },
      { id: 'glm-53-flash', modelId: 'glm-5.3-flash', displayName: 'GLM-5.3-Flash' }
    ]
    const deepseek = createProviderFromPreset('deepseek', 'key-ds')
    deepseek.id = 'deepseek'
    deepseek.name = 'DeepSeek'
    deepseek.models = [{ id: 'ds-flash', modelId: 'deepseek-v4-flash', displayName: 'deepseek-v4-flash' }]
    const custom = createCustomProvider('Custom GLM', 'https://custom.example/v1')
    custom.id = 'custom-glm'
    custom.apiKey = 'key-custom'
    custom.models = [
      { id: 'custom-glm-52', modelId: 'glm-5.2', displayName: 'GLM-5.2' }
    ]
    return {
      version: 2,
      providers: [glm, deepseek, custom],
      activeModel: { providerId: glm.id, modelEntryId: glm.models[0]!.id }
    }
  }

  it('canonical providerId::modelEntryId resolves', () => {
    const registry = buildRegistry()
    const result = resolveModelSelector(registry, 'glm::glm-52')
    expect(result.status).toBe('resolved')
    if (result.status === 'resolved') {
      expect(result.ref).toEqual({ providerId: 'glm', modelEntryId: 'glm-52' })
    }
  })

  it('unique displayName resolves', () => {
    const registry = buildRegistry()
    // deepseek-v4-flash only once
    const result = resolveModelSelector(registry, 'deepseek-v4-flash')
    expect(result.status).toBe('resolved')
  })

  it('alias exact normalized match resolves', () => {
    const registry = buildRegistry()
    const result = resolveModelSelector(registry, 'GLM 5.2 Flash')
    expect(result.status).toBe('resolved')
    if (result.status === 'resolved') expect(result.entry.id).toBe('glm-52')
  })

  it('explicit provider + model disambiguates', () => {
    const registry = buildRegistry()
    const result = resolveModelSelector(registry, 'GLM glm-5.2')
    expect(result.status).toBe('resolved')
    if (result.status === 'resolved') {
      expect(result.provider.id).toBe('glm')
    }
  })

  it('cross-provider same modelId without provider is ambiguous with bounded candidates', () => {
    const registry = buildRegistry()
    const result = resolveModelSelector(registry, 'glm-5.2')
    expect(result.status).toBe('ambiguous')
    if (result.status === 'ambiguous') {
      expect(result.candidates.length).toBeGreaterThan(1)
      expect(result.candidates.length).toBeLessThanOrEqual(5)
    }
  })

  it('not_found when no exact normalized key', () => {
    const registry = buildRegistry()
    const result = resolveModelSelector(registry, 'unknown-model-xyz')
    expect(result.status).toBe('not_found')
  })

  it('unavailable when provider disabled', () => {
    const registry = buildRegistry()
    registry.providers[0]!.enabled = false
    const result = resolveModelSelector(registry, 'glm::glm-52')
    expect(result.status).toBe('unavailable')
    if (result.status === 'unavailable') expect(result.reason).toBe('provider_disabled')
  })

  it('unavailable when model retired', () => {
    const registry = buildRegistry()
    registry.providers[0]!.models[0]!.retired = true
    const result = resolveModelSelector(registry, 'glm::glm-52')
    expect(result.status).toBe('unavailable')
    if (result.status === 'unavailable') expect(result.reason).toBe('model_retired')
  })

  it('unavailable when credentials missing', () => {
    const registry = buildRegistry()
    registry.providers[0]!.apiKey = ''
    const result = resolveModelSelector(registry, 'glm::glm-52')
    expect(result.status).toBe('unavailable')
    if (result.status === 'unavailable') expect(result.reason).toBe('credentials_missing')
  })

  it('已登记模型接受受支持的 effort，未知能力模型明确 fail closed', () => {
    const registry = buildRegistry()
    const known = resolveModelSelector(registry, 'glm::glm-53-flash', 'max')
    expect(known.status).toBe('resolved')
    if (known.status === 'resolved') {
      expect(known.supportedEfforts).toEqual(['auto', 'low', 'high', 'max'])
    }

    const unknown = resolveModelSelector(registry, 'deepseek::ds-flash', 'max')
    expect(unknown.status).toBe('unsupported_effort')
    if (unknown.status === 'unsupported_effort') {
      expect(unknown.supportedEfforts).toBeNull()
    }
  })

  it('validateReasoningEffort returns known set or unknown capability', () => {
    const registry = buildRegistry()
    const known = registry.providers[0]!.models[2]!
    const unknown = registry.providers[1]!.models[0]!
    expect(validateReasoningEffort(known, 'max')).toEqual(expect.objectContaining({ ok: true }))
    expect(validateReasoningEffort(unknown, 'max')).toEqual({
      ok: false,
      requestedEffort: 'max',
      supportedEfforts: null
    })
    expect(validateReasoningEffort(unknown, 'auto')).toEqual({ ok: true, supportedEfforts: null })
  })
})

describe('getModelDirectory', () => {
  it('stable sort, bounded, no sensitive fields, unavailable reason consistent', () => {
    const glm = createProviderFromPreset('glm', 'key-glm')
    glm.id = 'glm'
    glm.name = 'GLM'
    const ds = createProviderFromPreset('deepseek', '')
    ds.id = 'deepseek'
    ds.name = 'DeepSeek'
    ds.models[0]!.retired = true
    const registry: LlmRegistry = {
      version: 2,
      providers: [glm, ds],
      activeModel: { providerId: glm.id, modelEntryId: glm.models[0]!.id }
    }
    const dir = getModelDirectory(registry, { limit: 50, maxChars: 20_000 })
    expect(dir.total).toBe(glm.models.length + ds.models.length)
    expect(dir.entries.length).toBeLessThanOrEqual(50)
    const raw = JSON.stringify(dir.entries)
    expect(raw).not.toContain('baseUrl')
    expect(raw).not.toContain('apiKey')
    const unavailable = dir.entries.find(entry => entry.availability === 'unavailable')
    expect(unavailable?.reason).toBe('model_retired')
    expect(unavailable?.supportedEfforts).toBeNull()
    const names = dir.entries.map(entry => entry.providerName)
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)))
  })
})

import { describe, expect, it } from 'vitest'
import {
  resolveChildModelFromHeader,
  resolveChildModelFromProfile
} from '../../../src/main/agent/subagents/childModelRouting'
import type { LlmRegistry, ProviderConfig } from '../../../src/shared/config'
import type { SubagentProfileSnapshot } from '../../../src/shared/subagents'

const profile: SubagentProfileSnapshot = {
  profileId: 'code',
  name: 'code',
  description: 'code child',
  systemPrompt: 'work',
  toolNames: ['read'],
  permissionCeiling: 'read_only',
  maxToolRounds: 20,
  configHash: 'hash',
  model: {
    providerId: 'provider-a',
    modelEntryId: 'model-a',
    reasoningEffort: 'auto'
  }
}

const highEffortProfile: SubagentProfileSnapshot = {
  ...profile,
  model: {
    providerId: 'provider-a',
    modelEntryId: 'model-a',
    reasoningEffort: 'high'
  }
}

function createProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'provider-a',
    name: 'Provider A',
    baseUrl: 'https://provider-a.example/v1',
    apiKey: 'routing-test-key',
    enabled: true,
    toolDialect: 'native',
    models: [{
      id: 'model-a',
      modelId: 'glm-5.2',
      contextWindow: 64_000,
      supportsVision: true,
      reasoningEffort: 'medium'
    }],
    ...overrides
  }
}

function registry(): LlmRegistry {
  return {
    version: 2,
    providers: [
      createProvider(),
      {
        id: 'provider-b',
        name: 'Provider B',
        baseUrl: 'https://provider-b.example/v1',
        apiKey: 'routing-test-key-b',
        enabled: true,
        models: [{
          id: 'model-b',
          modelId: 'glm-5.3-flash',
          contextWindow: 32_000,
          supportsVision: false,
          reasoningEffort: 'low'
        }]
      }
    ],
    activeModel: { providerId: 'provider-b', modelEntryId: 'model-b' }
  }
}

describe('child model routing', () => {
  it('profile binding wins over active model and uses entry capabilities', () => {
    const reg = registry()
    reg.providers[0]!.models[0]!.reasoningEffort = undefined
    const resolved = resolveChildModelFromProfile(reg, profile)

    expect(resolved.header).toEqual({
      providerId: 'provider-a',
      modelEntryId: 'model-a',
      modelId: 'glm-5.2',
      reasoningEffort: 'auto'
    })
    expect(resolved.modelConfig).toMatchObject({
      modelId: 'glm-5.2',
      apiKey: 'routing-test-key',
      contextWindow: 64_000,
      supportsVision: true,
      cacheProfile: 'glm',
      toolDialect: 'native'
    })
    expect(resolved.modelConfig).not.toHaveProperty('reasoningEffort')
  })

  it('unbound profile uses the active model entry default effort', () => {
    const resolved = resolveChildModelFromProfile(registry(), { ...profile, model: undefined })
    expect(resolved.header.reasoningEffort).toBe('low')
  })

  it('unbound profile resolves the registry active model and its default effort', () => {
    const reg = registry()
    // 覆盖 activeModel 的 entry 默认值，让未绑定 profile 回落到 auto
    reg.providers[1]!.models[0]!.reasoningEffort = undefined
    const resolved = resolveChildModelFromProfile(reg, {
      ...profile,
      model: undefined
    })

    expect(resolved.header).toEqual({
      providerId: 'provider-b',
      modelEntryId: 'model-b',
      modelId: 'glm-5.3-flash',
      reasoningEffort: 'auto'
    })
  })

  it('header effort stays frozen when the registry default changes', () => {
    const header = resolveChildModelFromProfile(registry(), profile).header
    const changed = registry()
    changed.providers[0]!.models[0]!.reasoningEffort = 'low'

    const restored = resolveChildModelFromHeader(changed, header)

    expect(restored.header.reasoningEffort).toBe('auto')
    // 恢复路径以持久 header 为准；header 为 auto 时不得回退到 entry 默认 effort
    expect(restored.modelConfig).not.toHaveProperty('reasoningEffort')
  })

  it('rejects a public modelId drift during header recovery', () => {
    const header = resolveChildModelFromProfile(registry(), profile).header
    const changed = registry()
    changed.providers[0]!.models[0]!.modelId = 'changed-model'

    expect(() => resolveChildModelFromHeader(changed, header)).toThrow()
  })

  it.each([
    {
      name: 'disabled provider',
      mutate: (value: LlmRegistry) => { value.providers[0]!.enabled = false }
    },
    {
      name: 'missing provider',
      mutate: (value: LlmRegistry) => { value.providers = value.providers.slice(1) }
    },
    {
      name: 'missing credentials',
      mutate: (value: LlmRegistry) => { value.providers[0]!.apiKey = '' }
    },
    {
      name: 'missing model entry',
      mutate: (value: LlmRegistry) => { value.providers[0]!.models = [] }
    },
    {
      name: 'retired model entry',
      mutate: (value: LlmRegistry) => { value.providers[0]!.models[0]!.retired = true }
    }
  ])('$name is rejected without active-model fallback', ({ mutate }) => {
    const header = resolveChildModelFromProfile(registry(), profile).header
    const unavailable = registry()
    mutate(unavailable)

    expect(() => resolveChildModelFromHeader(unavailable, header)).toThrow()
  })

  it('rejects legacy profile model references before child creation', () => {
    expect(() => resolveChildModelFromProfile(registry(), {
      ...profile,
      model: { providerId: 'provider-a', modelId: 'glm-5.2' }
    })).toThrow()
  })

  it('single override wins over profile binding and validates effort support', () => {
    const reg = registry()
    expect(() => resolveChildModelFromProfile(reg, profile, {
      modelOverride: { providerId: 'provider-b', modelEntryId: 'model-b' },
      reasoningEffortOverride: 'medium'
    })).toThrow(/不支持思考强度/)

    const ok = resolveChildModelFromProfile(reg, profile, {
      modelOverride: { providerId: 'provider-b', modelEntryId: 'model-b' },
      reasoningEffortOverride: 'max'
    })
    expect(ok.header).toEqual({
      providerId: 'provider-b',
      modelEntryId: 'model-b',
      modelId: 'glm-5.3-flash',
      reasoningEffort: 'max'
    })
  })

  it('effort priority: single override > profile effort > entry default > auto', () => {
    const reg = registry()
    expect(resolveChildModelFromProfile(reg, profile, {
      reasoningEffortOverride: 'max'
    }).header.reasoningEffort).toBe('max')
    expect(resolveChildModelFromProfile(reg, highEffortProfile).header.reasoningEffort).toBe('high')
    expect(resolveChildModelFromProfile(reg, { ...profile, model: undefined }).header.reasoningEffort).toBe('low')

    reg.providers[1]!.models[0]!.reasoningEffort = undefined
    expect(resolveChildModelFromProfile(reg, { ...profile, model: undefined }).header.reasoningEffort).toBe('auto')
  })
})
